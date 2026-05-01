/**
 * SOHAM Orchestrator — The Brain Layer
 * ──────────────────────────────────────
 * Coordinates: Tool execution → Short-term memory → Long-term memory → Prompt assembly
 *
 * Memory architecture:
 *
 *   SHORT-TERM (session context)
 *     • Supabase `chat_history`  — last N messages across devices
 *     • Upstash Vector RAG       — similarity-matched recent snippets
 *
 *   LONG-TERM (persistent facts)
 *     • Supabase `memories`      — extracted facts, preferences, skills
 *     • Searched via cosine similarity on every request
 *     • Extracted asynchronously after each conversation turn
 *
 * Flow:
 *   User message
 *       ↓
 *   executeSohamTool()          ← news / weather / sports / finance / web search
 *       ↓
 *   [parallel]
 *     queryRagContext()          ← Upstash Vector short-term snippets
 *     loadCrossDeviceHistory()   ← Supabase recent chat history
 *     searchLongTermMemories()   ← Supabase memories (facts/prefs/skills)
 *       ↓
 *   buildSohamPromptContext()    → enriched prompt
 *       ↓
 *   AI Model (smart-fallback)
 *       ↓
 *   persistSohamMemory()         ← store to Supabase + Upstash (non-blocking)
 *   extractLongTermMemories()    ← extract facts via Cerebras (non-blocking)
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

export interface SohamContextResult {
  prompt: string;
  toolsUsed: SohamToolResult[];
  ragContextCount: number;
  crossDeviceHistoryCount: number;
  longTermMemoryCount: number;
  userProfileLoaded: boolean;
  publicKnowledgeCount: number;
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

  // Always attempt extraction — don't gate on ENABLE_MEMORY_SYSTEM
  const service = getMemoryExtractionService();
  service
    .extractAndStore({ userMessage, assistantResponse: assistantMessage, userId })
    .catch(err => console.warn('[Orchestrator] Long-term memory extraction failed:', err));
}

// ─── Main context builder ─────────────────────────────────────────────────────

/**
 * Build an enriched prompt by combining:
 *  1. Tool results (weather, news, sports, finance, web search)
 *  2. User profile (name, preferences, likes/dislikes — from Supabase)
 *  3. Short-term: cross-device chat history (Supabase chat_history)
 *  4. Short-term: RAG context snippets (Upstash Vector)
 *  5. Long-term: extracted memories (Supabase memories table)
 *  6. Public knowledge: suggestions & corrections (Upstash Vector, shared)
 */
export async function buildSohamPromptContext(input: {
  message: string;
  history?: MessageData[];
  userId?: string;
}): Promise<SohamContextResult> {
  const { message, userId } = input;

  const profileService = getUserProfileService();
  const knowledgeService = getUpstashKnowledgeService();

  const [
    toolResult,
    ragSnippets,
    crossDeviceHistory,
    longTermMemories,
    userProfile,
    publicKnowledge,
  ] = await Promise.all([
    executeSohamTool(message),
    queryRagContext(userId, message, 4),
    loadCrossDeviceHistory(userId, 6),
    searchLongTermMemories(userId, message),
    userId ? profileService.getProfile(userId) : Promise.resolve(null),
    knowledgeService.searchKnowledge(message, 3, 0.52),
  ]);

  const toolsUsed = toolResult ? [toolResult] : [];
  const contextBlocks: string[] = [];

  // ── Tool results ────────────────────────────────────────────────────────────
  if (toolResult) {
    contextBlocks.push(
      `[TOOL: ${toolResult.tool}]\n` +
      `Query: ${toolResult.query}\n` +
      `Status: ${toolResult.ok ? 'ok' : 'error'}\n` +
      `${toolResult.output}`
    );
  }

  // ── User profile (personal info, preferences, likes/dislikes) ──────────────
  if (userProfile) {
    const profileContext = profileService.buildProfileContext(userProfile);
    if (profileContext.trim().length > 0) {
      contextBlocks.push(
        `[USER PROFILE — personalise your response using this]\n${profileContext}`
      );
    }
  }

  // ── Long-term memory (facts, preferences, skills) ───────────────────────────
  if (longTermMemories.length > 0) {
    contextBlocks.push(
      `[LONG-TERM MEMORY — what I know about this user]\n` +
      longTermMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')
    );
  }

  // ── Short-term: recent cross-device chat history ────────────────────────────
  if (crossDeviceHistory.length > 0) {
    const historyText = crossDeviceHistory
      .slice(-4)
      .map(m => `${m.role === 'user' ? 'User' : 'SOHAM'}: ${m.content}`)
      .join('\n');
    contextBlocks.push(`[SHORT-TERM MEMORY — recent conversation history]\n${historyText}`);
  }

  // ── Short-term: RAG similarity snippets ────────────────────────────────────
  if (ragSnippets.length > 0) {
    contextBlocks.push(
      `[SHORT-TERM MEMORY — relevant past context]\n` +
      ragSnippets.map((x, i) => `${i + 1}. ${x}`).join('\n')
    );
  }

  // ── Public knowledge: suggestions & corrections ─────────────────────────────
  if (publicKnowledge.length > 0) {
    const knowledgeText = knowledgeService.formatForPrompt(publicKnowledge);
    contextBlocks.push(
      `[PUBLIC KNOWLEDGE — verified suggestions & corrections, use when relevant]\n${knowledgeText}`
    );
  }

  const prompt =
    contextBlocks.length === 0
      ? message
      : `${message}\n\n---\nMemory context (use when relevant, don't mention unless asked):\n\n${contextBlocks.join('\n\n')}`;

  return {
    prompt,
    toolsUsed,
    ragContextCount: ragSnippets.length,
    crossDeviceHistoryCount: crossDeviceHistory.length,
    longTermMemoryCount: longTermMemories.length,
    userProfileLoaded: userProfile !== null,
    publicKnowledgeCount: publicKnowledge.length,
  };
}

// ─── Persist conversation (non-blocking) ─────────────────────────────────────

/**
 * Persist conversation to Supabase (cross-device history) and Upstash (RAG).
 * Also triggers async long-term memory extraction.
 * Non-blocking — call with .catch(() => {}) to avoid blocking responses.
 */
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
