/**
 * POST /api/chat/stream
 * ─────────────────────────────────────────────────────────────────────────────
 * SSE streaming chat endpoint.
 *
 * Event types sent to client:
 *   { type: 'status',  text: string }           — pipeline stage label
 *   { type: 'token',   text: string }           — one AI token
 *   { type: 'image',   url, provider, text }    — image generation result
 *   { type: 'play',    tool, ok, openUrl,
 *                      embedUrl, video, … }      — YouTube play result (render iframe + tab fallback)
 *   { type: 'sources', sources: [{ title, url, tool }] } — research URLs used (deduped, ≤12)
 *   { type: 'tools',   toolsUsed: string[] }    — Groq builtin tools invoked (browser_search, …)
 *   { type: 'done',    modelUsed, autoRouted, agentTools, agentPlannedBy }  — stream finished
 *   { type: 'error',   text: string }           — fatal error
 */

import type { Request, Response } from 'express';
import { streamWithSmartFallback, getFriendlyErrorMessage } from '../routing/smart-fallback';
import {
  buildSohamPromptContext,
  persistSohamMemory,
  extractLongTermMemoriesAsync,
  triggerAutoLearnAsync,
} from '../core/orchestrator';
import { getIntentDetector } from '../core/intent-detector';
import { planToolCalls, isSohamAgentDisabled } from '../core/soham-agent';
import { collectResearchSources } from '../tools/agent-tools';
import { getSOHAMPipeline } from '../image/soham-image-pipeline';
import { buildSystemPrompt } from './system-prompt';
import { resolveAutoRoute } from '../routing/auto-router';
import { logger } from '../utils/logger';
import { parseGroqToolOptions } from '../routing/groq-tool-options';
import { stripInjectedContext } from '../utils/clean-message';
import { TokenOutputSanitizer } from '../utils/sanitize-model-output';

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseWrite(res: Response, data: object): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function sseEnd(res: Response): void {
  if (!res.writableEnded) {
    res.end();
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function chatStreamHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const { message, history = [], settings = {}, userId } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'MISSING_MESSAGE', message: 'message field is required' });
    return;
  }
  if (message.length > 10000) {
    res.status(400).json({ error: 'MESSAGE_TOO_LONG', message: 'Message exceeds 10,000 characters' });
    return;
  }
  let groqToolOptions;
  try { groqToolOptions = parseGroqToolOptions(settings); }
  catch (error) {
    res.status(400).json({ error: 'INVALID_GROQ_TOOL_OPTIONS', message: error instanceof Error ? error.message : 'Invalid Groq tool options' });
    return;
  }

  // ── SSE headers ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/Render proxy buffering
  res.flushHeaders();

  // ── Abort on client disconnect ───────────────────────────────────────────────
  // Use res.on('close') — fires when the actual TCP connection drops.
  // req.on('close') fires when the request body is consumed (immediately for POST).
  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  // ── Hard SSE timeout — 5 minutes max ────────────────────────────────────────
  const SSE_TIMEOUT_MS = 5 * 60_000;
  const sseTimeout = setTimeout(() => {
    if (!res.writableEnded) {
      sseWrite(res, { type: 'error', text: 'Response timeout. Please try again.' });
      sseEnd(res);
    }
  }, SSE_TIMEOUT_MS);

  // ── Single heartbeat — keeps proxies alive, cleared in finally ───────────────
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 2000);

  try {
    const convertedHistory = history.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      content: msg.content,
    }));
    // Frontend appends a SOHAM_CLOCK block to `message`; strip it for intent
    // routing and memory. The model prompt keeps it (it needs the time).
    const userMessage = stripInjectedContext(message) || message;

    // ── Intent detection (regex — deterministic fallback) ────────────────────
    const intentDetector = getIntentDetector();
    const intent = intentDetector.detect(userMessage, convertedHistory);

    // ── Model-driven plan (SOHAM agent): the model decides which tools this
    // request needs — playback, search+page reading, wikipedia, charts, image
    // gen, memory extraction… Falls back to regex routing on any failure.
    const agentDisabled = isSohamAgentDisabled();
    const agentPlan = agentDisabled ? null : await planToolCalls(userMessage, convertedHistory).catch(() => null);
    const planImage = agentPlan?.tools.find(t => t.tool === 'image_generate');
    const planChart = agentPlan?.tools.find(t => t.tool === 'chart');
    // Short-circuits are for single-purpose plans only (or no plan + regex).
    // A chart/image inside a MIXED plan runs inline via the agent — the SVG or
    // generated image rides the `image` SSE event after context settles — so
    // the other tools in the plan are not silently dropped.
    const planImageOnly = Boolean(agentPlan && agentPlan.tools.length > 0 && agentPlan.tools.every(t => t.tool === 'image_generate'));
    const planChartOnly = Boolean(agentPlan && agentPlan.tools.length > 0 && agentPlan.tools.every(t => t.tool === 'chart'));
    const imageFromRegex = !agentPlan && intent.intent === 'IMAGE_GENERATION' && intent.confidence > 0.6;
    const chartFromRegex = !agentPlan && intent.intent === 'CHART_GENERATION' && intent.confidence > 0.6;
    const imageWanted = planImageOnly || imageFromRegex;
    const chartWanted = !imageWanted && (planChartOnly || chartFromRegex);
    const imagePrompt = planImage?.query || intent.extractedQuery || userMessage;
    const chartPrompt = planChart?.query || intent.extractedQuery || userMessage;

    // ── Image generation ─────────────────────────────────────────────────────
    if (imageWanted) {
      sseWrite(res, { type: 'status', text: 'Generating image…' });
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: imagePrompt,
          userId: userId || 'anonymous',
        });

        sseWrite(res, { type: 'image', url: imageResult.url, provider: imageResult.provider, text: "✨ Here's your image!" });
        sseWrite(res, { type: 'done', modelUsed: `image/${imageResult.model}`, autoRouted: false, responseTime: `${Date.now() - startTime}ms` });

        persistSohamMemory({ userId, userMessage, assistantMessage: `[Image generated: ${imageResult.enhancedPrompt}]` }).catch(() => {});
        sseEnd(res);
        return;
      } catch (imageError) {
        logger.warn('[Stream] Image generation failed, falling back to text', {
          error: imageError instanceof Error ? imageError.message : String(imageError),
        });
        // fall through to text generation
      }
    }

    // ── Chart generation (deterministic SVG — never the diffusion pipeline) ──
    if (chartWanted) {
      sseWrite(res, { type: 'status', text: 'Drawing chart…' });
      try {
        const { runChartPipeline } = await import('../flows/chart');
        const chart = await runChartPipeline({
          query: chartPrompt,
          preferredModel: typeof settings.model === 'string' && settings.model !== 'auto' ? settings.model : undefined,
        });

        const noteSuffix = chart.note ? `\n\n_${chart.note}_` : '';
        const content = `**${chart.title}**\n\n${chart.tableMarkdown}${noteSuffix}`;

        // Stream the table as one token chunk so the markdown renders, then the
        // SVG as an image event — same rendering path as image generation.
        sseWrite(res, { type: 'token', text: content });
        sseWrite(res, { type: 'image', url: chart.imageDataUri, provider: 'soham-chart', text: chart.title });
        sseWrite(res, { type: 'done', modelUsed: chart.modelUsed ? `chart/${chart.modelUsed}` : 'chart/soham-svg', autoRouted: false, responseTime: `${Date.now() - startTime}ms` });

        persistSohamMemory({ userId, userMessage, assistantMessage: `[Chart generated: ${chart.title}]\n\n${chart.tableMarkdown}` }).catch(() => {});
        sseEnd(res);
        return;
      } catch (chartError) {
        logger.warn('[Stream] Chart pipeline failed, falling back to text', {
          error: chartError instanceof Error ? chartError.message : String(chartError),
        });
        // fall through to text generation
      }
    }

    // ── Build context ────────────────────────────────────────────────────────
    sseWrite(res, { type: 'status', text: 'Thinking…' });

    let agentContext: Awaited<ReturnType<typeof buildSohamPromptContext>>;
    let systemPrompt: string;
    try {
      [systemPrompt, agentContext] = await Promise.all([
        Promise.resolve(buildSystemPrompt(settings.tone || 'helpful', settings.technicalLevel || 'intermediate')),
        buildSohamPromptContext({ message, history: convertedHistory, userId, agentPlan }),
      ]);
    } finally {
      clearInterval(heartbeat);
    }


    if (clientGone) { sseEnd(res); return; }

    if (agentContext.toolsUsed.length > 0) {
      const toolNames = agentContext.toolsUsed.map((t: any) => t.tool).join(', ');
      sseWrite(res, { type: 'status', text: `Using: ${toolNames}…` });
    }

    // Emit a dedicated play event so the chat page can mount the iframe (and its
    // "open in tab" fallback) without waiting for the full model response.
    const playTool = agentContext.toolsUsed.find((t: any) => t?.tool === 'play_video');
    if (playTool) {
      sseWrite(res, {
        type: 'play',
        tool: 'play_video',
        ok: !!playTool.ok,
        openUrl: playTool.openUrl,   // watch URL (or search URL when ok=false)
        embedUrl: playTool.embedUrl, // undefined when ok=false
        video: playTool.video,       // { videoId, title, channel, thumbnailUrl }
        ...(playTool.sources ? { candidates: playTool.sources.slice(1) } : {}),
      });
    }

    // A mixed plan (chart + other tools) lands here instead of the chart
    // short-circuit — emit the SVG through the same image event.
    const chartResult = agentContext.toolsUsed.find((t: any) => t?.chart);
    if (chartResult?.chart) {
      sseWrite(res, { type: 'image', url: chartResult.chart.imageDataUri, provider: 'soham-chart', text: chartResult.chart.title });
    }

    // Same for a mixed plan carrying image_generate: render now, emit the image
    // event, and let the text reply be synthesized alongside it.
    const imageAsk = agentContext.toolsUsed.find((t: any) => t?.tool === 'image_generate' && t.ok);
    if (imageAsk) {
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: imageAsk.query || userMessage,
          userId: userId || 'anonymous',
        });
        sseWrite(res, { type: 'image', url: imageResult.url, provider: imageResult.provider, text: "✨ Here's your image!" });
      } catch (imageError) {
        logger.warn('[Stream] Mixed-plan image generation failed', {
          error: imageError instanceof Error ? imageError.message : String(imageError),
        });
      }
    }

    // Structured research sources → citations UI. Emitted once, after context
    // settles and before tokens, so the client can render the citation list
    // while the answer streams in. Deduped by URL, tool-tagged, capped at 12.
    const researchSources = collectResearchSources(agentContext.toolsUsed);
    if (researchSources.length > 0) {
      sseWrite(res, { type: 'sources', sources: researchSources });
    }

    // ── Routing ──────────────────────────────────────────────────────────────
    // Auto mode: pick the best model per intent.
    // Manual mode: honour the user's explicit model choice.
    const isAutoMode = !settings.model || settings.model === 'auto';
    let preferredModelId: string | undefined;
    let modelChain: string[] | undefined;
    let routingCategory: any;
    let generationParams = { temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens: 4096 };

    if (isAutoMode) {
      const autoRoute = resolveAutoRoute(intent.intent);
      preferredModelId = autoRoute.preferredModelId || undefined;
      modelChain = autoRoute.modelChain;
      routingCategory = autoRoute.category;
      generationParams = autoRoute.params;
    } else {
      preferredModelId = settings.model;
      routingCategory = 'general';
    }

    // ── Stream tokens ────────────────────────────────────────────────────────
    sseWrite(res, { type: 'status', text: 'Generating response…' });

    let modelUsed = 'unknown';
    let autoRouted = false;
    let fullText = '';
    // Free-router models sometimes leak tool-call/reasoning markup as tokens.
    // Filter it live — the client renders tokens as they arrive and cannot retract.
    const outputSanitizer = new TokenOutputSanitizer();

    const tokenStream = streamWithSmartFallback(
      {
        prompt: agentContext.prompt,
        systemPrompt,
        history: convertedHistory,
        preferredModelId,
        modelChain,
        category: routingCategory,
        params: generationParams,
        ...groqToolOptions,
      },
      (selectedModel) => { modelUsed = selectedModel; }
    );

    // Manually drain the generator so we capture the return value (metadata)
    let streamResult = await tokenStream.next();
    while (!streamResult.done) {
      if (clientGone) break;
      const token = streamResult.value as string;
      const clean = outputSanitizer.push(token);
      if (clean) {
        fullText += clean;
        sseWrite(res, { type: 'token', text: clean });
      }
      streamResult = await tokenStream.next();
    }
    const tail = outputSanitizer.flush();
    if (tail) {
      fullText += tail;
      sseWrite(res, { type: 'token', text: tail });
    }
    fullText = fullText.trim();
    // If the model produced nothing but markup, the client is staring at an empty
    // bubble — say something rather than nothing.
    if (!fullText && !clientGone) {
      fullText = 'I had trouble generating a response — please try again.';
      sseWrite(res, { type: 'token', text: fullText });
    }

    // Capture final metadata from generator return value
    if (streamResult.done && streamResult.value) {
      const meta = streamResult.value as { modelUsed: string; fallbackTriggered: boolean; toolsUsed?: string[] };
      modelUsed = meta.modelUsed ?? modelUsed;
      autoRouted = meta.fallbackTriggered ?? false;
      if (meta.toolsUsed?.length) {
        sseWrite(res, { type: 'tools', toolsUsed: meta.toolsUsed });
      }
    }

    if (clientGone) { sseEnd(res); return; }

    sseWrite(res, {
      type: 'done',
      modelUsed,
      autoRouted,
      agentTools: agentContext.agentTools,        // [] when the planner chose no tools / regex fallback
      agentPlannedBy: agentContext.agentPlannedBy, // 'model' | 'fallback'
      responseTime: `${Date.now() - startTime}ms`,
      ...(agentContext.degradedLayers.length > 0 && { degradedLayers: agentContext.degradedLayers }),
    });
    sseEnd(res);

    // ── Non-blocking post-processing ─────────────────────────────────────────
    if (fullText) {
      persistSohamMemory({ userId, userMessage, assistantMessage: fullText })
        .catch(err => logger.warn('[Stream] Memory persist failed', { error: err instanceof Error ? err.message : String(err) }));
      if (agentContext.agentMemoryExtract !== false) extractLongTermMemoriesAsync(userId, userMessage, fullText);
      triggerAutoLearnAsync({ userMessage, assistantMessage: fullText, toolResults: agentContext.toolsUsed, modelUsed });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const diagnostic = error && typeof error === 'object' && 'diagnostic' in error
      ? String((error as { diagnostic: unknown }).diagnostic)
      : errorMessage;
    logger.error('[Stream] Fatal error', { error: diagnostic, userId });
    sseWrite(res, { type: 'error', text: getFriendlyErrorMessage(error) });
    sseEnd(res);
  } finally {
    clearTimeout(sseTimeout);
    clearInterval(heartbeat);
  }
}
