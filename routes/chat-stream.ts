/**
 * POST /api/chat/stream
 * ─────────────────────────────────────────────────────────────────────────────
 * SSE streaming chat endpoint.
 *
 * Event types sent to client:
 *   { type: 'status',  text: string }           — pipeline stage label
 *   { type: 'token',   text: string }           — one AI token
 *   { type: 'image',   url, provider, text }    — image generation result
 *   { type: 'done',    modelUsed, autoRouted }  — stream finished
 *   { type: 'error',   text: string }           — fatal error
 */

import type { Request, Response } from 'express';
import { streamWithSmartFallback } from '../routing/smart-fallback';
import {
  buildSohamPromptContext,
  persistSohamMemory,
  extractLongTermMemoriesAsync,
  triggerAutoLearnAsync,
} from '../core/orchestrator';
import { getIntentDetector } from '../core/intent-detector';
import { getSOHAMPipeline } from '../image/soham-image-pipeline';
import { buildSystemPrompt } from './system-prompt';
import { resolveAutoRoute } from '../routing/auto-router';
import { logger } from '../utils/logger';

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

    // ── Intent detection ─────────────────────────────────────────────────────
    const intentDetector = getIntentDetector();
    const intent = intentDetector.detect(message, convertedHistory);

    // ── Image generation ─────────────────────────────────────────────────────
    if (intent.intent === 'IMAGE_GENERATION' && intent.confidence > 0.6) {
      sseWrite(res, { type: 'status', text: 'Generating image…' });
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: intent.extractedQuery || message,
          userId: userId || 'anonymous',
        });

        sseWrite(res, { type: 'image', url: imageResult.url, provider: imageResult.provider, text: "✨ Here's your image!" });
        sseWrite(res, { type: 'done', modelUsed: `image/${imageResult.model}`, autoRouted: false, responseTime: `${Date.now() - startTime}ms` });

        persistSohamMemory({ userId, userMessage: message, assistantMessage: `[Image generated: ${imageResult.enhancedPrompt}]` }).catch(() => {});
        sseEnd(res);
        return;
      } catch (imageError) {
        logger.warn('[Stream] Image generation failed, falling back to text', {
          error: imageError instanceof Error ? imageError.message : String(imageError),
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
        buildSohamPromptContext({ message, history: convertedHistory, userId }),
      ]);
    } finally {
      clearInterval(heartbeat);
    }


    if (clientGone) { sseEnd(res); return; }

    if (agentContext.toolsUsed.length > 0) {
      const toolNames = agentContext.toolsUsed.map((t: any) => t.tool).join(', ');
      sseWrite(res, { type: 'status', text: `Using: ${toolNames}…` });
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

    const tokenStream = streamWithSmartFallback(
      {
        prompt: agentContext.prompt,
        systemPrompt,
        history: convertedHistory,
        preferredModelId,
        modelChain,
        category: routingCategory,
        params: generationParams,
      },
      (selectedModel) => { modelUsed = selectedModel; }
    );

    // Manually drain the generator so we capture the return value (metadata)
    let streamResult = await tokenStream.next();
    while (!streamResult.done) {
      if (clientGone) break;
      const token = streamResult.value as string;
      fullText += token;
      sseWrite(res, { type: 'token', text: token });
      streamResult = await tokenStream.next();
    }

    // Capture final metadata from generator return value
    if (streamResult.done && streamResult.value) {
      const meta = streamResult.value as { modelUsed: string; fallbackTriggered: boolean };
      modelUsed = meta.modelUsed ?? modelUsed;
      autoRouted = meta.fallbackTriggered ?? false;
    }

    if (clientGone) { sseEnd(res); return; }

    sseWrite(res, {
      type: 'done',
      modelUsed,
      autoRouted,
      responseTime: `${Date.now() - startTime}ms`,
      ...(agentContext.degradedLayers.length > 0 && { degradedLayers: agentContext.degradedLayers }),
    });
    sseEnd(res);

    // ── Non-blocking post-processing ─────────────────────────────────────────
    if (fullText) {
      persistSohamMemory({ userId, userMessage: message, assistantMessage: fullText })
        .catch(err => logger.warn('[Stream] Memory persist failed', { error: err instanceof Error ? err.message : String(err) }));
      extractLongTermMemoriesAsync(userId, message, fullText);
      triggerAutoLearnAsync({ userMessage: message, assistantMessage: fullText, toolResults: agentContext.toolsUsed, modelUsed });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Stream] Fatal error', { error: errorMessage, userId });
    sseWrite(res, { type: 'error', text: 'Something went wrong. Please try again.' });
    sseEnd(res);
  } finally {
    clearTimeout(sseTimeout);
    clearInterval(heartbeat);
  }
}
