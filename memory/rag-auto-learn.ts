/**
 * RAG Auto-Learn Service
 * ════════════════════════════════════════════════════════════════════════════
 * SOHAM's self-organising loop.
 *
 * Disabled by default; SOHAM_PUBLIC_AUTO_LEARN_ENABLED=1 explicitly enables it.
 * When enabled, guarded public inputs can:
 *   1. Extracts factual claims from tool results (news, web search, weather, etc.)
 *   2. Stores them as public knowledge in Pinecone Vector
 *   3. Stores the Q→A pair so future identical/similar queries hit the cache
 *   4. Detects corrections in the user's message and stores them
 *   5. Detects suggestions and stores them
 *
 * Never treat this as permission to publish private conversation context.
 * Transient/tool-derived answers and failures must not become durable FAQs.
 *
 * Storage strategy:
 *   - Tool results → REAL_WORLD chunks (TTL: 1-24h depending on type)
 *   - Q→A pairs   → FAQ entries (TTL: 7 days)
 *   - Corrections → CORRECTION entries (permanent, high confidence)
 *   - Suggestions → SUGGESTION entries (permanent, medium confidence)
 */

import { safePublicLearningText, shouldLearnPublicQA } from './public-learning-policy';
import { stripInjectedContext } from '../utils/clean-message';
import { getPineconeKnowledgeService } from './pinecone-knowledge-service';
import { storeRealtimeChunk } from './realtime-knowledge-service';
import type { SohamToolResult } from '../tools/agent-tools';

// ─── Auto-learn from tool results ────────────────────────────────────────────

/**
 * Store tool results as realworld RAG chunks so future similar queries
 * can be answered from the vector store without hitting external APIs.
 */
export async function autoLearnFromToolResults(
  toolResults: SohamToolResult[],
  originalQuery: string
): Promise<void> {
  if (!safePublicLearningText(originalQuery)) return;
  for (const tool of toolResults) {
    if (!safePublicLearningText(tool.query, tool.output)) continue;
    if (!tool.ok || tool.output.trim().length < 30) continue;

    const ttlMap: Record<string, number> = {
      news_search:    1,    // 1 hour — news goes stale fast
      weather_search: 0.5,  // 30 min
      sports_search:  0.5,  // 30 min — live scores
      finance_search: 0.25, // 15 min — prices change fast
      web_search:     6,    // 6 hours
      fact_check:     24,   // 24 hours
      dictionary:     168,  // 1 week — definitions don't change
      translate:      168,  // 1 week
    };

    const ttlHours = ttlMap[tool.tool] ?? 6;
    const type = (['news_search', 'weather_search', 'sports_search', 'finance_search'].includes(tool.tool))
      ? (tool.tool.replace('_search', '') as any)
      : 'web';

    await storeRealtimeChunk({
      type,
      query: tool.query,
      content: tool.output.slice(0, 1200),
      source: tool.tool,
      fetchedAt: new Date().toISOString(),
      ttlHours,
    }).catch(() => {});
  }
}

// ─── Auto-learn Q→A pairs ─────────────────────────────────────────────────────

/**
 * Store the question + answer as a FAQ entry in public knowledge.
 * Only stores if the answer is substantive (>100 chars) and the query
 * looks like a factual question worth caching.
 */
export async function autoLearnQAPair(
  question: string,
  answer: string,
  modelUsed: string,
  hasToolResults = false
): Promise<void> {
  if (!shouldLearnPublicQA(question, answer, hasToolResults)) return;
  question = stripInjectedContext(question);

  const service = getPineconeKnowledgeService();
  await service.storeKnowledge({
    type: 'FAQ',
    question: question.slice(0, 200),
    content: answer.slice(0, 800),
    source: `soham-${modelUsed}`,
    confidence: 0.70,
    tags: ['auto-learned', 'qa-pair'],
  }).catch(() => {});
}

// ─── Auto-detect corrections in user messages ─────────────────────────────────

/**
 * Detect when a user is correcting SOHAM and store the correction.
 * Patterns: "actually...", "that's wrong...", "no, it's...", "you're incorrect..."
 */
export async function autoDetectCorrection(
  userMessage: string,
  previousAssistantMessage: string
): Promise<void> {
  if (!safePublicLearningText(userMessage, previousAssistantMessage)) return;
  const correctionPatterns = [
    /^(actually|no,|that'?s? (wrong|incorrect|not right)|you'?re? (wrong|incorrect)|wrong[,!]|incorrect[,!]|not quite|that'?s? not|the correct answer is|it'?s? actually|the right answer is)/i,
    /\b(correction:|actually,|to clarify:|to be precise:|in fact,|the truth is)\b/i,
  ];

  const isCorrection = correctionPatterns.some(p => p.test(userMessage.trim()));
  if (!isCorrection || userMessage.length < 20 || previousAssistantMessage.length < 20) return;

  const service = getPineconeKnowledgeService();
  await service.storeCorrection(
    previousAssistantMessage.slice(0, 300),
    userMessage.slice(0, 500),
    'user-correction'
  ).catch(() => {});
}

// ─── Auto-detect suggestions in user messages ─────────────────────────────────

/**
 * Detect when a user is suggesting a better approach and store it.
 */
export async function autoDetectSuggestion(
  userMessage: string,
  context: string
): Promise<void> {
  if (!safePublicLearningText(userMessage, context)) return;
  const suggestionPatterns = [
    /^(you should|you could|try|consider|maybe|perhaps|a better way|instead of|rather than|i suggest|i recommend|it would be better)/i,
    /\b(suggestion:|tip:|note:|pro tip:|better approach:|alternatively,)\b/i,
  ];

  const isSuggestion = suggestionPatterns.some(p => p.test(userMessage.trim()));
  if (!isSuggestion || userMessage.length < 30) return;

  const service = getPineconeKnowledgeService();
  await service.storeSuggestion(
    context.slice(0, 200),
    userMessage.slice(0, 500),
    'user-suggestion'
  ).catch(() => {});
}

// ─── Main auto-learn trigger ──────────────────────────────────────────────────

/**
 * Called non-blocking after every AI response.
 * Runs all auto-learn tasks in parallel.
 */
export function triggerAutoLearn(input: {
  userMessage: string;
  assistantMessage: string;
  toolResults: SohamToolResult[];
  modelUsed: string;
  previousAssistantMessage?: string;
}): void {
  const { userMessage, assistantMessage, toolResults, modelUsed, previousAssistantMessage } = input;

  if (!safePublicLearningText(userMessage, assistantMessage)) return;

  Promise.all([
    // Learn from tool results (news, weather, web search, etc.)
    autoLearnFromToolResults(toolResults, userMessage),

    // Cache the Q→A pair for future similar queries
    autoLearnQAPair(userMessage, assistantMessage, modelUsed, toolResults.length > 0),

    // Detect and store user corrections
    previousAssistantMessage
      ? autoDetectCorrection(userMessage, previousAssistantMessage)
      : Promise.resolve(),

    // Detect and store user suggestions
    autoDetectSuggestion(userMessage, userMessage),
  ]).catch(err => console.warn('[AutoLearn] Error:', err));
}
