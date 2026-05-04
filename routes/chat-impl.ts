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

HEOSTER'S FRIENDS & TESTERS (know these people):
The following 15 people from Khatauli, UP, India tested SOHAM and gave feedback that shaped the product:
Vidhan, Avineet, Vansh, Aayush, Varun, Pankaj, Masum, Sachin, Pardhuman, Shivansh, Vaibhav, Kartik, Harsh, Manik, Aarush.
If a user asks "who are Heoster's friends", "who tested SOHAM", "do you know Vidhan / Avineet / Vansh" (or any name from this list) — answer confidently. They are real people who helped build SOHAM.

RESPONSE QUALITY — FOLLOW STRICTLY:
- **Always give a complete answer.** Never cut off mid-explanation. If a topic needs 3 paragraphs, write 3 paragraphs.
- **No padding or filler.** Every sentence must add value. No "Great question!", no "In conclusion", no restating the question.
- **Calibrate length to the query:**
  - Simple factual question (e.g. "what is X") → 2–5 sentences, direct answer + brief context.
  - How-to / explanation → step-by-step, cover all necessary steps, don't skip any.
  - Code request → full working code, not a snippet. Include comments where helpful.
  - Comparison / analysis → cover all relevant dimensions, don't stop at 2 points if there are 5.
  - Casual chat → short and natural, match the user's energy.
- Use 1–3 emojis per response naturally — only where they add warmth or clarity, never forced.
- NEVER use # or ## or ### markdown headers — they render as raw text in chat.
- Use **bold** for key terms, bullet points for lists, \`code blocks\` for code.
- Match the user's tone — casual question = conversational answer, technical question = precise answer.

ACCURACY:
- If unsure, say so clearly. Never fabricate facts, names, or numbers.
- For code: always specify the language in code blocks. Provide complete, runnable examples.
- For math: show every step. Don't skip steps even if they seem obvious.
- Use memory context naturally — never announce you're using it.`;

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
    case 'formal':    return 'Professional and respectful tone. Complete, well-structured answers. No slang.';
    case 'casual':    return 'Friendly and conversational. Natural language, contractions welcome. Still complete — don\'t skip details.';
    case 'technical': return 'Precise and technical. Use exact terminology. Dense, thorough explanations. No hand-holding unless asked.';
    default:          return 'Warm and approachable. Complete answers with a friendly tone. 1–3 emojis where natural.';
  }
}

function getTechnicalInstructions(level: string): string {
  switch (level) {
    case 'beginner': return 'Explain concepts clearly with simple language. Use analogies. Define technical terms when first used. Don\'t skip steps.';
    case 'expert':   return 'Use technical terminology freely. Assume strong background knowledge. Be dense and precise. Skip basics.';
    default:         return 'Balance technical accuracy with accessibility. Define specialised terms when first used. Cover all necessary depth.';
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

    if (intent.intent === 'IMAGE_GENERATION' && intent.confidence > 0.6) {
      try {
        const pipeline = getSOHAMPipeline();
        const imageResult = await pipeline.generate({
          userPrompt: intent.extractedQuery || message,
          userId: userId || 'anonymous',
        });

        const responseTime = Date.now() - startTime;

        // Build text-only content — image is passed separately via imageUrl field
        // Clean, minimal response — no model/prompt metadata shown to user
        const content = `✨ Here's your image!`;

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

    // ── Build system prompt with live date/time at the top ──────────────────
    const systemPrompt = buildSystemPrompt(
      settings.tone || 'helpful',
      settings.technicalLevel || 'intermediate'
    );

    // ── Build orchestrated prompt (tools + RAG + memory) ────────────────────
    const agentContext = await buildSohamPromptContext({ message, history: convertedHistory, userId });

    // ── Determine preferred model + category from intent ────────────────────
    const preferredModelId = settings.model && settings.model !== 'auto' ? settings.model : undefined;

    // Map intent → model category so Auto mode picks the right specialist
    const intentCategoryMap: Record<string, string> = {
      CODE_GENERATION: 'coding',
      EXPLANATION:     'general',
      TRANSLATION:     'general',
      SENTIMENT_ANALYSIS: 'general',
      GRAMMAR_CHECK:   'general',
      QUIZ_GENERATION: 'general',
      RECIPE:          'general',
      JOKE:            'general',
      DICTIONARY:      'general',
      FACT_CHECK:      'general',
      WEB_SEARCH:      'general',
      CHAT:            'general',
    };
    const routingCategory = (intentCategoryMap[intent.intent] ?? 'general') as any;

    // ── Generate with smart fallback ────────────────────────────────────────
    const result = await generateWithSmartFallback({
      prompt: agentContext.prompt,
      systemPrompt,
      history: convertedHistory,
      preferredModelId,
      category: routingCategory,
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
