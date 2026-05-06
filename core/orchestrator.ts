/**
 * SOHAM Orchestrator — Hyper-Adaptive Brain Layer
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Memory architecture (7 layers):
 *
 *   LAYER 0 — REALTIME AWARENESS   (date/time + live data)
 *   LAYER 1 — TOOL RESULTS         (weather, news, sports, finance, web)
 *   LAYER 2 — USER PROFILE         (Supabase user_profiles)
 *   LAYER 3 — LONG-TERM MEMORY     (Supabase memories — cosine search)
 *   LAYER 4 — SHORT-TERM HISTORY   (Supabase chat_history — cross-device)
 *   LAYER 5 — SEMANTIC RAG         (Upstash Vector — private namespace)
 *   LAYER 6 — PUBLIC KNOWLEDGE     (Upstash Vector — public namespace)
 *
 * Resilience: every layer is fetched independently via Promise.allSettled.
 * A single failing layer (e.g. Supabase down) degrades gracefully — the
 * remaining layers still contribute to the context.
 *
 * Context size guard: assembled prompt is capped at MAX_CONTEXT_CHARS to
 * prevent exceeding model context windows.
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
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max chars for the assembled context block (~24k tokens at 4 chars/token) */
const MAX_CONTEXT_CHARS = 96_000;

/** Max chars per individual context block to prevent one layer dominating */
const MAX_BLOCK_CHARS = 2_000;

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
  /** Which layers failed (for observability) */
  degradedLayers: string[];
}

// ─── Long-term memory retrieval ───────────────────────────────────────────────

async function searchLongTermMemories(userId: string | undefined, query: string): Promise<string[]> {
  if (!userId) return [];
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
    .catch(err => logger.warn('[Orchestrator] Long-term memory extraction failed', {
      error: err instanceof Error ? err.message : String(err),
      userId,
    }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unwrap a settled result, returning the fallback on rejection */
function settled<T>(result: PromiseSettledResult<T>, fallback: T, layerName: string, degraded: string[]): T {
  if (result.status === 'fulfilled') return result.value;
  const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
  logger.warn(`[Orchestrator] Layer "${layerName}" failed`, { error: reason });
  degraded.push(layerName);
  return fallback;
}

/** Truncate a string to maxChars, appending '…' if cut */
function cap(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(0, maxChars - 1) + '…';
}

// ─── Main context builder ─────────────────────────────────────────────────────

/**
 * Build an enriched prompt combining all 7 memory layers + realtime context.
 *
 * Uses Promise.allSettled so a single failing layer never blocks the response.
 */
export async function buildSohamPromptContext(input: {
  message: string;
  history?: MessageData[];
  userId?: string;
}): Promise<SohamContextResult> {
  const { message, userId } = input;
  const degradedLayers: string[] = [];

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

  const needsRealtime = queryAnalysis.isTimeSensitive
    || queryAnalysis.queryType === 'news'
    || queryAnalysis.queryType === 'realtime';

  // ── Parallel fetch all layers — allSettled so one failure doesn't kill all ─
  const [
    toolResult$,
    ragSnippets$,
    crossDeviceHistory$,
    longTermMemories$,
    userProfile$,
    publicKnowledge$,
    realtimeCtx$,
  ] = await Promise.allSettled([
    executeSohamTool(message),
    queryRagContext(userId, message, 5),
    loadCrossDeviceHistory(userId, 6),
    searchLongTermMemories(userId, message),
    userId ? profileService.getProfile(userId) : Promise.resolve(null),
    knowledgeService.searchKnowledge(message, 4, 0.48),
    needsRealtime
      ? getRealtimeContext(message, realtimeQueryType as any)
      : Promise.resolve({ datetime: getCurrentDateTimeContext(), liveData: undefined }),
  ]);

  // Realworld cache — fast Upstash read, no external API
  const realtimeChunks = await queryRealtimeChunks(message, 3).catch(() => [] as string[]);

  // Unwrap results with graceful degradation
  const toolResult        = settled(toolResult$,        null,  'tool',         degradedLayers);
  const ragSnippets       = settled(ragSnippets$,       [],    'rag',          degradedLayers);
  const crossDeviceHistory = settled(crossDeviceHistory$, [], 'cross-device', degradedLayers);
  const longTermMemories  = settled(longTermMemories$,  [],    'long-term',    degradedLayers);
  const userProfile       = settled(userProfile$,       null,  'profile',      degradedLayers);
  const publicKnowledge   = settled(publicKnowledge$,   [],    'knowledge',    degradedLayers);
  const realtimeCtx       = settled(realtimeCtx$,
    { datetime: getCurrentDateTimeContext(), liveData: undefined },
    'realtime', degradedLayers);

  const toolsUsed = toolResult ? [toolResult] : [];
  const contextBlocks: string[] = [];

  // ── LAYER 0b: Live data ───────────────────────────────────────────────────
  const liveDataItems = realtimeCtx.liveData ?? [];
  const allRealtimeContent = [
    ...realtimeChunks,
    ...liveDataItems
      .filter(d => d.source !== 'upstash-cache')
      .map(d => d.content),
  ].filter(Boolean);

  if (allRealtimeContent.length > 0) {
    contextBlocks.push(
      `Live data:\n` +
      allRealtimeContent.map((c, i) => `${i + 1}. ${cap(c, 400)}`).join('\n\n')
    );
  }

  // ── LAYER 1: Tool results ─────────────────────────────────────────────────
  if (toolResult) {
    contextBlocks.push(
      `${toolResult.ok ? 'Current data' : 'Data lookup'}:\n` +
      cap(toolResult.output, MAX_BLOCK_CHARS)
    );
  }

  // ── LAYER 2: User profile ─────────────────────────────────────────────────
  if (userProfile) {
    const profileContext = profileService.buildProfileContext(userProfile);
    if (profileContext.trim().length > 0) {
      contextBlocks.push(`About this user:\n${cap(profileContext, MAX_BLOCK_CHARS)}`);
    }
  }

  // ── LAYER 3: Long-term memory ─────────────────────────────────────────────
  if (longTermMemories.length > 0) {
    contextBlocks.push(
      `What you know about this user:\n` +
      longTermMemories.map((m, i) => `${i + 1}. ${cap(m, 300)}`).join('\n')
    );
  }

  // ── LAYER 4: Short-term cross-device history ──────────────────────────────
  if (crossDeviceHistory.length > 0) {
    const historyText = crossDeviceHistory
      .slice(-4)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${cap(m.content as string, 500)}`)
      .join('\n');
    contextBlocks.push(`Recent conversation:\n${historyText}`);
  }

  // ── LAYER 5: Semantic RAG ─────────────────────────────────────────────────
  if (ragSnippets.length > 0) {
    contextBlocks.push(
      `Relevant context:\n` +
      ragSnippets.map((x, i) => `${i + 1}. ${cap(x, 300)}`).join('\n')
    );
  }

  // ── LAYER 6: Public knowledge ─────────────────────────────────────────────
  if (publicKnowledge.length > 0) {
    const knowledgeText = knowledgeService.formatForPrompt(publicKnowledge);
    contextBlocks.push(`Verified knowledge:\n${cap(knowledgeText, MAX_BLOCK_CHARS)}`);
  }

  // ── Assemble prompt with context size guard ───────────────────────────────
  const dtLine = buildDateTimePromptLine(realtimeCtx.datetime);

  let contextSection = contextBlocks.join('\n\n');
  if (contextSection.length > MAX_CONTEXT_CHARS) {
    logger.warn('[Orchestrator] Context truncated', {
      original: contextSection.length,
      limit: MAX_CONTEXT_CHARS,
      userId,
    });
    contextSection = contextSection.slice(0, MAX_CONTEXT_CHARS) + '\n[context truncated]';
  }

  const prompt = contextBlocks.length === 0
    ? message
    : `${message}\n\n---\n${dtLine}\n\nBackground context (use naturally — do NOT cite or reference these sources):\n\n${contextSection}`;

  if (degradedLayers.length > 0) {
    logger.info('[Orchestrator] Degraded layers', { layers: degradedLayers, userId });
  }

  return {
    prompt,
    toolsUsed,
    ragContextCount:         ragSnippets.length,
    crossDeviceHistoryCount: crossDeviceHistory.length,
    longTermMemoryCount:     longTermMemories.length,
    userProfileLoaded:       userProfile !== null,
    publicKnowledgeCount:    publicKnowledge.length,
    realtimeContextCount:    allRealtimeContent.length,
    currentDateTime:         realtimeCtx.datetime.utc,
    degradedLayers,
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

  await Promise.allSettled([
    persistCrossDeviceHistory(userId, userMessage, assistantMessage, metadata),
    upsertRagMemory(userId, 'user', userMessage),
    upsertRagMemory(userId, 'assistant', assistantMessage),
  ]);
}

// ─── Auto-learn trigger (non-blocking) ───────────────────────────────────────

export function triggerAutoLearnAsync(input: {
  userMessage: string;
  assistantMessage: string;
  toolResults: SohamToolResult[];
  modelUsed: string;
  previousAssistantMessage?: string;
}): void {
  triggerAutoLearn(input);
}
