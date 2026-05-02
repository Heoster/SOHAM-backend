/**
 * Chat Handler — Express implementation
 * POST /api/chat
 *
 * Full SOHAM orchestration:
 *   1. Input validation
 *   2. Safety guard check
 *   3. Task classification
 *   4. Build prompt context (tools + RAG + cross-device history)
 *   5. Smart fallback AI generation (Groq → Cerebras → Google → HF)
 *   6. Output safety check
 *   7. Persist memory (non-blocking)
 */

import type { Request, Response } from 'express';
import { generateWithSmartFallback } from '../routing/smart-fallback';
import { buildSohamPromptContext, persistSohamMemory, extractLongTermMemoriesAsync, triggerAutoLearnAsync } from '../core/orchestrator';
import { getIntentDetector } from '../core/intent-detector';
import { getSOHAMPipeline } from '../image/soham-image-pipeline';
import { buildDeveloperIdentityPrompt } from '../config/developer-profile';
import { getCurrentDateTimeContext } from '../memory/realtime-knowledge-service';

// Static part of the system prompt — date/time is injected dynamically per request
const SOHAM_BASE_PROMPT = `You are SOHAM, an intelligent and versatile assistant.

${buildDeveloperIdentityPrompt()}

RESPONSE FORMATTING RULES:
- NEVER use # or ## or ### markdown headers
- Use **bold** for emphasis, bullet points for lists, code blocks for code
- Keep responses conversational — paragraphs and bullets only

RESPONSE GUIDELINES:
1. Be Accurate: If unsure, say so. Don't fabricate.
2. Be Concise: Get to the point.
3. Stay Focused: Address the actual question directly.
4. For code: Always specify the language in code blocks.
5. For math: Show step-by-step working.
6. Use memory context naturally — don't announce that you're using it.`;

/**
 * Build the full system prompt with live date/time injected at the top.
 * The date/time line is the FIRST thing the model reads so it cannot be missed.
 */
function buildSystemPrompt(tone: string, technicalLevel: string): string {
  const dt = getCurrentDateTimeContext();

  // Format: "Saturday, 03 May 2026 — 08:45 UTC"
  const dtLine = `TODAY: ${dt.dayOfWeek}, ${dt.date} — ${dt.time}`;

  return `${dtLine}

${SOHAM_BASE_PROMPT}

REALTIME AWARENESS:
- The current date and time is stated at the very top of this prompt: "${dtLine}"
- Always use this when answering questions about today's date, current time, day of week, or how long ago something happened.
- Never say you don't know the current date or time.

PERSONALITY & COMMUNICATION STYLE:
${getToneInstructions(tone)}

TECHNICAL DEPTH:
${getTechnicalInstructions(technicalLevel)}`;
}

function getToneInstructions(tone: string): string {
  switch (tone) {
    case 'formal': return 'Use professional language, proper grammar, and a respectful tone.';
    case 'casual': return 'Be friendly and conversational. Use simple language and contractions.';
    default: return 'Be warm, approachable, and supportive. Balance professionalism with friendliness.';
  }
}

function getTechnicalInstructions(level: string): string {
  switch (level) {
    case 'beginner': return 'Explain concepts in simple terms. Avoid jargon and use analogies.';
    case 'expert': return 'Use technical terminology freely. Provide in-depth explanations.';
    default: return 'Balance technical accuracy with accessibility. Define specialized terms when first used.';
  }
}

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

    // ── Intent detection — handle image generation before AI call ───────────
    const intentDetector = getIntentDetector();
    const intent = intentDetector.detect(message, convertedHistory);

    if (intent.intent === 'IMAGE_GENERATION' && intent.confidence > 0.7) {
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: intent.extractedQuery || message,
          userId: userId || 'anonymous',
        });

        const responseTime = Date.now() - startTime;

        // Build text-only content — image is passed separately via imageUrl field
        // NEVER embed base64 data URLs in markdown (they get mangled by the parser)
        const providerLabel = imageResult.provider === 'cloudflare'
          ? 'Cloudflare Workers AI'
          : imageResult.provider === 'pollinations'
          ? 'Pollinations.ai'
          : 'HuggingFace';

        const content = [
          `Here's your generated image!`,
          ``,
          `**Prompt:** ${imageResult.enhancedPrompt}`,
          `**Provider:** ${providerLabel} · **Model:** ${imageResult.model} · **Time:** ${imageResult.generationTime}ms`,
        ].join('\n');

        persistSohamMemory({ userId, userMessage: message, assistantMessage: `[Image generated: ${imageResult.enhancedPrompt}]` }).catch(() => {});

        res.json({
          success: true,
          content,
          modelUsed: `image/${imageResult.model}`,
          autoRouted: false,
          imageUrl: imageResult.url,
          imageProvider: imageResult.provider,
          responseTime: `${responseTime}ms`,
          timestamp: new Date().toISOString(),
        });
        return;
      } catch (imageError) {
        console.warn('[Chat] Image generation failed, falling back to text:', imageError instanceof Error ? imageError.message : imageError);
        // Fall through to text response
      }
    }

    // ── Build system prompt ─────────────────────────────────────────────────
    const systemPrompt = `${SOHAM_SYSTEM_PROMPT}

PERSONALITY & COMMUNICATION STYLE:
${getToneInstructions(settings.tone || 'helpful')}

TECHNICAL DEPTH:
${getTechnicalInstructions(settings.technicalLevel || 'intermediate')}`;

    // ── Build orchestrated prompt (tools + RAG + memory) ────────────────────
    const agentContext = await buildSohamPromptContext({ message, history: convertedHistory, userId });

    // ── Determine preferred model ───────────────────────────────────────────
    const preferredModelId = settings.model && settings.model !== 'auto' ? settings.model : undefined;

    // ── Generate with smart fallback ────────────────────────────────────────
    const result = await generateWithSmartFallback({
      prompt: agentContext.prompt,
      systemPrompt,
      history: convertedHistory,
      preferredModelId,
      category: 'general',
      params: { temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens: 4096 },
    });

    // ── Persist short-term memory (non-blocking) ────────────────────────────
    persistSohamMemory({
      userId,
      userMessage: message,
      assistantMessage: result.response.text,
      metadata: { toolsUsed: agentContext.toolsUsed.map((t: any) => t.tool), modelUsed: result.modelUsed },
    }).catch(() => {});

    // ── Extract long-term memories (non-blocking) ────────────────────────────
    extractLongTermMemoriesAsync(userId, message, result.response.text);

    // ── Auto-learn: store tool results + Q→A pairs + detect corrections ──────
    triggerAutoLearnAsync({
      userMessage: message,
      assistantMessage: result.response.text,
      toolResults: agentContext.toolsUsed,
      modelUsed: result.modelUsed,
      previousAssistantMessage: history.length > 0
        ? history[history.length - 1]?.content
        : undefined,
    });

    const responseTime = Date.now() - startTime;

    res.json({
      success: true,
      content: result.response.text,
      modelUsed: result.modelUsed,
      autoRouted: result.fallbackTriggered,
      routingReasoning: result.fallbackTriggered ? 'Fallback triggered' : 'Direct model usage',
      toolsUsed: agentContext.toolsUsed,
      ragContextCount: agentContext.ragContextCount,
      crossDeviceHistoryCount: agentContext.crossDeviceHistoryCount,
      longTermMemoryCount: agentContext.longTermMemoryCount,
      userProfileLoaded: agentContext.userProfileLoaded,
      publicKnowledgeCount: agentContext.publicKnowledgeCount,
      realtimeContextCount: agentContext.realtimeContextCount,
      currentDateTime: agentContext.currentDateTime,
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Chat API] Error:', error);

    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage,
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
    });
  }
}
