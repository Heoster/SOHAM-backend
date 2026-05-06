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
import { getSOHAMPipeline } from '../image/soham-image-pipeline';
import { buildSystemPrompt } from './system-prompt';
import { resolveAutoRoute } from '../routing/auto-router';

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

    // ── Convert history ─────────────────────────────────────────────────────
    const convertedHistory = history.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      content: msg.content,
    }));

    // ── Intent detection ────────────────────────────────────────────────────
    const intentDetector = getIntentDetector();
    const intent = intentDetector.detect(message, convertedHistory);

    if (intent.intent === 'IMAGE_GENERATION' && intent.confidence > 0.6) {
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: intent.extractedQuery || message,
          userId: userId || 'anonymous',
        });

        persistSohamMemory({ userId, userMessage: message, assistantMessage: `[Image generated: ${imageResult.enhancedPrompt}]` }).catch(() => {});

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

    // ── Build system prompt + orchestrated context ──────────────────────────
    const systemPrompt = buildSystemPrompt(settings.tone || 'helpful', settings.technicalLevel || 'intermediate');
    const agentContext = await buildSohamPromptContext({ message, history: convertedHistory, userId });

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
    });

    // ── Non-blocking post-processing ────────────────────────────────────────
    persistSohamMemory({
      userId,
      userMessage: message,
      assistantMessage: result.response.text,
      metadata: { toolsUsed: agentContext.toolsUsed.map((t: any) => t.tool), modelUsed: result.modelUsed },
    }).catch(() => {});
    extractLongTermMemoriesAsync(userId, message, result.response.text);
    triggerAutoLearnAsync({
      userMessage: message,
      assistantMessage: result.response.text,
      toolResults: agentContext.toolsUsed,
      modelUsed: result.modelUsed,
      previousAssistantMessage: history.length > 0 ? history[history.length - 1]?.content : undefined,
    });

    res.json({
      success: true,
      content: result.response.text,
      modelUsed: result.modelUsed,
      autoRouted: result.fallbackTriggered,
      toolsUsed: agentContext.toolsUsed,
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
