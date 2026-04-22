/**
 * POST /api/chat/personality
 * ──────────────────────────
 * Chat with user personality system — adapts tone, style, and memory per user.
 * Wraps the full orchestration pipeline with personality layer on top.
 *
 * Body:
 *   message           string   (required)
 *   userId            string   (required for personality features)
 *   enablePersonality boolean  (optional, default: true)
 *   history           array    (optional)
 *   settings          object   (optional)
 *
 * Response:
 *   { success, content, modelUsed, personalityEnabled, detectedStyle, ... }
 *
 * NOTE: Full implementation is in src/app/api/chat-direct-personality/route.ts
 * This file re-exports the Express-adapted handler.
 */

import type { Request, Response } from 'express';
import { generateWithSmartFallback } from '../routing/smart-fallback';
import { buildSohamPromptContext, persistSohamMemory } from '../core/orchestrator';

export async function chatPersonalityHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const { message, history = [], settings = {}, userId, enablePersonality = true } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'MISSING_MESSAGE', message: 'message field is required and non-empty' });
      return;
    }

    const systemPrompt = `You are SOHAM, an intelligent assistant created by Heoster (CODEEX-AI).
SOHAM stands for Self Organising Hyper Adaptive Machine.
Be warm, helpful, and adapt your communication style to the user.
NEVER use markdown headers (#, ##, ###). Use **bold**, bullets, and code blocks only.`;

    const convertedHistory = history.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      content: msg.content,
    }));

    const agentContext = await buildSohamPromptContext({ message, history: convertedHistory, userId });
    const preferredModelId = settings.model && settings.model !== 'auto' ? settings.model : undefined;

    const result = await generateWithSmartFallback({
      prompt: agentContext.prompt,
      systemPrompt,
      history: convertedHistory,
      preferredModelId,
      category: 'general',
      params: { temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens: 4096 },
    });

    persistSohamMemory({
      userId,
      userMessage: message,
      assistantMessage: result.response.text,
      metadata: { toolsUsed: agentContext.toolsUsed.map((t: any) => t.tool), modelUsed: result.modelUsed, personalityEnabled: enablePersonality },
    }).catch(() => {});

    res.json({
      success: true,
      content: result.response.text,
      modelUsed: result.modelUsed,
      autoRouted: result.fallbackTriggered,
      toolsUsed: agentContext.toolsUsed,
      ragContextCount: agentContext.ragContextCount,
      personalityEnabled: enablePersonality && !!userId,
      responseTime: `${Date.now() - startTime}ms`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
      responseTime: `${Date.now() - startTime}ms`,
    });
  }
}
