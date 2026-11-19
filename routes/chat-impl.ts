/**
 * Chat Handler — Express implementation
 * POST /api/chat
 *
 * Full SOHAM orchestration:
 *   1. Input validation
 *   2. Intent detection (image vs text)
 *   3. Build prompt context (tools + RAG + memory)
 *   4. Smart fallback AI generation
 *   5. Persist memory (non-blocking)
 */

import type { Request, Response } from 'express';
import { generateWithSmartFallback } from '../routing/smart-fallback';
import { buildSohamPromptContext, persistSohamMemory, extractLongTermMemoriesAsync, triggerAutoLearnAsync } from '../core/orchestrator';
import { getIntentDetector } from '../core/intent-detector';
import { planToolCalls, isSohamAgentDisabled } from '../core/soham-agent';
import { collectResearchSources } from '../tools/agent-tools';
import { stripInjectedContext } from '../utils/clean-message';
import { getSOHAMPipeline } from '../image/soham-image-pipeline';
import { sanitizeModelOutput } from '../utils/sanitize-model-output';
import { buildSystemPrompt } from './system-prompt';
import { resolveAutoRoute } from '../routing/auto-router';
import { parseGroqToolOptions } from '../routing/groq-tool-options';

export async function chatHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const { message, history = [], settings = {}, userId } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'MISSING_MESSAGE', message: 'message field is required' });
      return;
    }
    if (message.trim().length === 0) {
      res.status(400).json({ error: 'EMPTY_MESSAGE', message: 'Message cannot be empty' });
      return;
    }
    if (message.length > 10000) {
      res.status(400).json({ error: 'MESSAGE_TOO_LONG', message: 'Message exceeds 10,000 characters', maxLength: 10000 });
      return;
    }
    let groqToolOptions;
    try { groqToolOptions = parseGroqToolOptions(settings); }
    catch (error) {
      res.status(400).json({ error: 'INVALID_GROQ_TOOL_OPTIONS', message: error instanceof Error ? error.message : 'Invalid Groq tool options' });
      return;
    }

    // ── Convert history ─────────────────────────────────────────────────────
    const convertedHistory = history.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      content: msg.content,
    }));

    // Frontend appends a SOHAM_CLOCK block; strip it for intent routing and
    // memory writes. The model prompt keeps it (it needs the time).
    const userMessage = stripInjectedContext(message) || message;

    // ── Intent detection (regex — deterministic fallback) ───────────────────
    const intentDetector = getIntentDetector();
    const intent = intentDetector.detect(userMessage, convertedHistory);

    // ── Model-driven plan (SOHAM agent) with regex fallback ─────────────────
    const agentDisabled = isSohamAgentDisabled();
    const agentPlan = agentDisabled ? null : await planToolCalls(userMessage, convertedHistory).catch(() => null);
    const planImage = agentPlan?.tools.find(t => t.tool === 'image_generate');
    const planChart = agentPlan?.tools.find(t => t.tool === 'chart');
    // Short-circuits are for single-purpose plans only (or no plan + regex).
    // A chart/image inside a MIXED plan runs inline via the agent and its
    // payload travels with the response (imageUrl / imageProvider below).
    const planImageOnly = Boolean(agentPlan && agentPlan.tools.length > 0 && agentPlan.tools.every(t => t.tool === 'image_generate'));
    const planChartOnly = Boolean(agentPlan && agentPlan.tools.length > 0 && agentPlan.tools.every(t => t.tool === 'chart'));
    const imageFromRegex = !agentPlan && intent.intent === 'IMAGE_GENERATION' && intent.confidence > 0.6;
    const chartFromRegex = !agentPlan && intent.intent === 'CHART_GENERATION' && intent.confidence > 0.6;
    const imageWanted = planImageOnly || imageFromRegex;
    const chartWanted = !imageWanted && (planChartOnly || chartFromRegex);
    const imagePrompt = planImage?.query || intent.extractedQuery || userMessage;
    const chartPrompt = planChart?.query || intent.extractedQuery || userMessage;

    if (imageWanted) {
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: imagePrompt,
          userId: userId || 'anonymous',
        });

        persistSohamMemory({ userId, userMessage, assistantMessage: `[Image generated: ${imageResult.enhancedPrompt}]` }).catch(() => {});

        res.json({
          success: true,
          content: `✨ Here's your image!`,
          modelUsed: `image/${imageResult.model}`,
          autoRouted: false,
          imageUrl: imageResult.url,
          imageProvider: imageResult.provider,
          responseTime: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        });
        return;
      } catch (imageError) {
        console.warn('[Chat] Image generation failed, falling back to text:', imageError instanceof Error ? imageError.message : imageError);
      }
    }

    // ── Chart generation (deterministic SVG — never the diffusion pipeline) ──
    if (chartWanted) {
      try {
        const { runChartPipeline } = await import('../flows/chart');
        const chart = await runChartPipeline({
          query: chartPrompt,
          preferredModel: typeof settings.model === 'string' && settings.model !== 'auto' ? settings.model : undefined,
        });

        const noteSuffix = chart.note ? `\n\n_${chart.note}_` : '';
        const content = `**${chart.title}**\n\n${chart.tableMarkdown}${noteSuffix}`;

        persistSohamMemory({ userId, userMessage, assistantMessage: `[Chart generated: ${chart.title}]\n\n${chart.tableMarkdown}` }).catch(() => {});

        res.json({
          success: true,
          content,
          modelUsed: chart.modelUsed ? `chart/${chart.modelUsed}` : 'chart/soham-svg',
          autoRouted: false,
          imageUrl: chart.imageDataUri,
          imageProvider: 'soham-chart',
          responseTime: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        });
        return;
      } catch (chartError) {
        console.warn('[Chat] Chart pipeline failed, falling back to text:', chartError instanceof Error ? chartError.message : chartError);
      }
    }

    // ── Build system prompt + orchestrated context ──────────────────────────
    const systemPrompt = buildSystemPrompt(settings.tone || 'helpful', settings.technicalLevel || 'intermediate');
    const agentContext = await buildSohamPromptContext({ message, history: convertedHistory, userId, agentPlan });

    // ── Routing ─────────────────────────────────────────────────────────────
    // In Auto mode: resolve the best model per intent.
    // In manual mode: honour the user's explicit model choice.
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

    // ── Generate ────────────────────────────────────────────────────────────
    const result = await generateWithSmartFallback({
      prompt: agentContext.prompt,
      systemPrompt,
      history: convertedHistory,
      preferredModelId,
      modelChain,
      category: routingCategory,
      params: generationParams,
      ...groqToolOptions,
    });

    // Strip any tool-call/reasoning markup the model leaked as plain text
    // (free-router models do this) before showing/persisting it.
    const responseText = sanitizeModelOutput(result.response.text)
      || 'I had trouble generating a response — please try again.';

    // ── Non-blocking post-processing ────────────────────────────────────────
    persistSohamMemory({
      userId,
      userMessage,
      assistantMessage: responseText,
      metadata: { toolsUsed: [...agentContext.toolsUsed.map((t: any) => t.tool), ...(result.response.toolsUsed ?? [])], modelUsed: result.modelUsed },
    }).catch(() => {});
    if (agentContext.agentMemoryExtract !== false) extractLongTermMemoriesAsync(userId, userMessage, responseText);
    triggerAutoLearnAsync({
      userMessage,
      assistantMessage: responseText,
      toolResults: agentContext.toolsUsed,
      modelUsed: result.modelUsed,
      previousAssistantMessage: history.length > 0 ? history[history.length - 1]?.content : undefined,
    });

    // Flattened, deduped research sources (same payload shape as the SSE
    // `sources` event). Per-tool sources remain nested inside toolsUsed too.
    const researchSources = collectResearchSources(agentContext.toolsUsed);

    // A chart that was part of a mixed plan (chart + other tools) rides this
    // same response — the SVG goes out as imageUrl/imageProvider so the client
    // can render it exactly like a generated chart.
    const mixedChart = agentContext.toolsUsed.find((t: any) => t?.chart)?.chart;

    // Same for a mixed plan carrying image_generate — render now and attach it.
    const imageAsk = agentContext.toolsUsed.find((t: any) => t?.tool === 'image_generate' && t.ok);
    let mixedImage: { url: string; provider: string } | undefined;
    if (imageAsk) {
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: imageAsk.query || userMessage,
          userId: userId || 'anonymous',
        });
        mixedImage = { url: imageResult.url, provider: imageResult.provider };
      } catch (imageError) {
        console.warn('[Chat] Mixed-plan image generation failed:', imageError instanceof Error ? imageError.message : imageError);
      }
    }

    res.json({
      success: true,
      content: responseText,
      modelUsed: result.modelUsed,
      autoRouted: result.fallbackTriggered,
      toolsUsed: [...agentContext.toolsUsed, ...(result.response.toolsUsed ?? []).map(tool => ({ tool, source: 'groq' }))],
      ...(mixedChart ? { imageUrl: mixedChart.imageDataUri, imageProvider: 'soham-chart' } : {}),
      ...(mixedImage ? { imageUrl: mixedImage.url, imageProvider: mixedImage.provider } : {}),
      sources: researchSources,
      agentPlannedBy: agentContext.agentPlannedBy,
      agentTools: agentContext.agentTools,
      currentDateTime: agentContext.currentDateTime,
      responseTime: `${Date.now() - startTime}ms`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Chat API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage,
      responseTime: `${Date.now() - startTime}ms`,
      timestamp: new Date().toISOString(),
    });
  }
}
