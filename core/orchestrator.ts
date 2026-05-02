/**
 * SOHAM Orchestrator — Hyper-Adaptive Brain Layer
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Memory architecture (6 layers):
 *
 *   LAYER 0 — REALTIME AWARENESS
 *     • Current date/time injected into every prompt
 *     • Live news/web search cached in Upstash as REAL_WORLD chunks
 *     • Stale chunks expire automatically (TTL per data type)
 *
 *   LAYER 1 — USER PROFILE (Supabase user_profiles)
 *     • Name, age, location, occupation, preferences
 *     • Likes/dislikes, custom facts
 *     • Auto-updated from every conversation
 *
 *   LAYER 2 — LONG-TERM MEMORY (Supabase memories)
 *     • Extracted facts, preferences, skills per user
 *     • Cosine similarity search on every request
 *
 *   LAYER 3 — SHORT-TERM HISTORY (Supabase chat_history)
 *     • Last N messages across all devices
 *     • Cross-device continuity
 *
 *   LAYER 4 — SEMANTIC RAG (Upstash Vector — private namespace)
 *     • Semantic similarity search on past conversations
 *     • Recency + importance weighted scoring
 *
 *   LAYER 5 — PUBLIC KNOWLEDGE (Upstash Vector — public namespace)
 *     • Verified corrections, suggestions, FAQs
 *     • Auto-learned from every tool result and AI response
 *     • Shared across all users
 *
 *   LAYER 6 — REALWORLD CACHE (Upstash Vector — realworld namespace)
 *     • Live news, weather, web search results
 *     • TTL-based expiry (15min–24h depending on data type)
 *     • Reduces external API calls for repeated queries
 *
 * Self-organising loop:
 *   Every response → triggerAutoLearn() → stores tool results + Q→A pairs
 *   → future similar queries hit the vector store instead of external APIs
 */

import type { MessageData } from '../adapters/types';
import { executeSohamTool, type SohamToolResult } from '../tools/agent-tools';
import {
  loadCrossDeviceHistory,
  persistCrossDeviceHistory,
} from '../memory/agent-memory';
import {
  queryRagContext,
  upsertRagMemory,
} from '../memory/enhanced-rag';
import { getMemorySystemService } from '../memory/memory-system-service';
import { getMemoryExtractionService } from '../memory/memory-extraction-service';
import { getUserProfileService } from '../memory/user-profile-service';
import { getUpstashKnowledgeService } from '../memory/upstash-knowledge-service';
import {
  getCurrentDateTimeContext,
  buildDateTimePromptLine,
  queryRealtimeChunks,
  getRealtimeContext,
} from '../memory/realtime-knowledge-service';
import { triggerAutoLearn } from '../memory/rag-auto-learn';
import { analyzeQuery } from '../tools/search-engine';

export interface SohamContextResult {
  prompt: string;
  toolsUsed: SohamToolResult[];
  ragContextCount: number;
  crossDeviceHistoryCount: number;
  longTermMemoryCount: number;
  userProfileLoaded: boolean;
  publicKnowledgeCount: number;
  realtimeContextCount: number;
  currentDateTime: string;
}

// ─── Long-term memory retrieval ───────────────────────────────────────────────

async function searchLongTermMemories(userId: string | undefined, query: string): Promise<string[]> {
  if (!userId) return [];
  try {
    const memoryService = getMemorySystemService();
    const results = await memoryService.searchMemories({
      userId,
      queryText: query,
      topK: 5,
      minSimilarity: 0.45,
    });
    return results.map(r => {
      const cat = r.memory.metadata.category.toLowerCase();
      return `[${cat}] ${r.memory.content}`;
    });
  } catch {
    return [];
  }
}

// ─── Long-term memory extraction (non-blocking) ───────────────────────────────

export function extractLongTermMemoriesAsync(
  userId: string | undefined,
  userMessage: string,
  assistantMessage: string
): void {
  if (!userId) return;
  const service = getMemoryExtractionService();
  service
    .extractAndStore({ userMessage, assistantResponse: assistantMessage, userId })
    .catch(err => console.warn('[Orchestrator] Long-term memory extraction failed:', err));
}

// ─── Main context builder ─────────────────────────────────────────────────────

/**
 * Build an enriched prompt combining all 6 memory layers + realtime context.
 */
export async function buildSohamPromptContext(input: {
  message: string;
  history?: MessageData[];
  userId?: string;
}): Promise<SohamContextResult> {
  const { message, userId } = input;

  const profileService   = getUserProfileService();
  const knowledgeService = getUpstashKnowledgeService();

  // Analyse query type for smarter realtime fetching
  const queryAnalysis = analyzeQuery(message);
  const realtimeQueryType = queryAnalysis.queryType === 'news'    ? 'news'
    : queryAnalysis.queryType === 'weather'  ? 'weather'
    : queryAnalysis.queryType === 'finance'  ? 'finance'
    : queryAnalysis.queryType === 'sports'   ? 'sports'
    : queryAnalysis.isTimeSensitive          ? 'web'
    : 'general';

  // ── Parallel fetch all layers ─────────────────────────────────────────────
  const [
    toolResult,
    ragSnippets,
    crossDeviceHistory,
    longTermMemories,
    userProfile,
    publicKnowledge,
    realtimeCtx,
  ] = await Promise.all([
    executeSohamTool(message),
    queryRagContext(userId, message, 5),
    loadCrossDeviceHistory(userId, 6),
    searchLongTermMemories(userId, message),
    userId ? profileService.getProfile(userId) : Promise.resolve(null),
    knowledgeService.searchKnowledge(message, 4, 0.48),
    // Only fetch realtime context for time-sensitive or news queries
    (queryAnalysis.isTimeSensitive || queryAnalysis.queryType === 'news' || queryAnalysis.queryType === 'realtime')
      ? getRealtimeContext(message, realtimeQueryType as any)
      : Promise.resolve({ datetime: getCurrentDateTimeContext(), liveData: undefined }),
  ]);

  // Also query realworld cache for any query type (fast, no external call)
  const realtimeChunks = await queryRealtimeChunks(message, 3).catch(() => [] as string[]);

  const toolsUsed = toolResult ? [toolResult] : [];
  const contextBlocks: string[] = [];

  // ── LAYER 0: Realtime awareness — always inject date/time ─────────────────
  const dtLine = buildDateTimePromptLine(realtimeCtx.datetime);
  // This goes into the system prompt prefix, not a context block

  // ── LAYER 0b: Live data from realtime service ─────────────────────────────
  const liveDataItems = realtimeCtx.liveData ?? [];
  const allRealtimeContent = [
    ...realtimeChunks,
    ...liveDataItems
      .filter(d => d.source !== 'upstash-cache') // avoid duplicating cached chunks
      .map(d => d.content),
  ].filter(Boolean);

  if (allRealtimeContent.length > 0) {
    contextBlocks.push(
      `[REALTIME DATA — live information fetched now]\n` +
      allRealtimeContent.map((c, i) => `${i + 1}. ${c.slice(0, 400)}`).join('\n\n')
    );
  }

  // ── LAYER 1: Tool results (weather, news, sports, finance, web search) ────
  if (toolResult) {
    contextBlocks.push(
      `[TOOL: ${toolResult.tool}]\n` +
      `Query: ${toolResult.query}\n` +
      `Status: ${toolResult.ok ? 'ok' : 'error'}\n` +
      `${toolResult.output}`
    );
  }

  // ── LAYER 2: User profile ─────────────────────────────────────────────────
  if (userProfile) {
    const profileContext = profileService.buildProfileContext(userProfile);
    if (profileContext.trim().length > 0) {
      contextBlocks.push(
        `[USER PROFILE — personalise your response using this]\n${profileContext}`
      );
    }
  }

  // ── LAYER 3: Long-term memory ─────────────────────────────────────────────
  if (longTermMemories.length > 0) {
    contextBlocks.push(
      `[LONG-TERM MEMORY — what I know about this user]\n` +
      longTermMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')
    );
  }

  // ── LAYER 4: Short-term cross-device history ──────────────────────────────
  if (crossDeviceHistory.length > 0) {
    const historyText = crossDeviceHistory
      .slice(-4)
      .map(m => `${m.role === 'user' ? 'User' : 'SOHAM'}: ${m.content}`)
      .join('\n');
    contextBlocks.push(`[SHORT-TERM MEMORY — recent conversation history]\n${historyText}`);
  }

  // ── LAYER 5: Semantic RAG snippets ────────────────────────────────────────
  if (ragSnippets.length > 0) {
    contextBlocks.push(
      `[SEMANTIC MEMORY — relevant past context]\n` +
      ragSnippets.map((x, i) => `${i + 1}. ${x}`).join('\n')
    );
  }

  // ── LAYER 6: Public knowledge (corrections, suggestions, FAQs) ───────────
  if (publicKnowledge.length > 0) {
    const knowledgeText = knowledgeService.formatForPrompt(publicKnowledge);
    contextBlocks.push(
      `[PUBLIC KNOWLEDGE — verified facts, corrections & suggestions]\n${knowledgeText}`
    );
  }

  // ── Assemble final prompt ─────────────────────────────────────────────────
  const prompt = contextBlocks.length === 0
    ? message
    : `${message}\n\n---\n${dtLine}\n\nMemory & knowledge context (use when relevant, don't mention sources unless asked):\n\n${contextBlocks.join('\n\n')}`;

  return {
    prompt,
    toolsUsed,
    ragContextCount:        ragSnippets.length,
    crossDeviceHistoryCount: crossDeviceHistory.length,
    longTermMemoryCount:    longTermMemories.length,
    userProfileLoaded:      userProfile !== null,
    publicKnowledgeCount:   publicKnowledge.length,
    realtimeContextCount:   allRealtimeContent.length,
    currentDateTime:        realtimeCtx.datetime.utc,
  };
}

// ─── Persist conversation (non-blocking) ─────────────────────────────────────

export async function persistSohamMemory(input: {
  userId?: string;
  userMessage: string;
  assistantMessage: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { userId, userMessage, assistantMessage, metadata } = input;
  if (!userId) return;

  await Promise.all([
    persistCrossDeviceHistory(userId, userMessage, assistantMessage, metadata),
    upsertRagMemory(userId, 'user', userMessage),
    upsertRagMemory(userId, 'assistant', assistantMessage),
  ]);
}

// ─── Auto-learn trigger (non-blocking) ───────────────────────────────────────

/**
 * Trigger the self-organising auto-learn loop after every response.
 * Stores tool results, Q→A pairs, corrections, and suggestions.
 */
export function triggerAutoLearnAsync(input: {
  userMessage: string;
  assistantMessage: string;
  toolResults: SohamToolResult[];
  modelUsed: string;
  previousAssistantMessage?: string;
}): void {
  triggerAutoLearn(input);
}
