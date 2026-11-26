/**
 * Enhanced RAG Memory — Pinecone Vector + Supabase
 * ════════════════════════════════════════════════
 *
 * Replaces the basic hash-embedding approach with:
 *   • Real semantic embeddings via Google gemini-embedding-001
 *   • Pinecone Vector for fast ANN (approximate nearest-neighbour) search
 *   • Supabase for durable long-term storage with metadata
 *   • Recency weighting: recent memories score higher
 *   • Deduplication: skip near-identical memories (cosine > 0.95)
 *   • Namespace isolation: every user gets their own vector namespace
 *
 * Pinecone Vector REST API docs: https://docs.pinecone.io/reference/api/introduction
 */

import { randomUUID } from 'crypto';
import { generateEmbedding } from './embeddings';
export { generateEmbedding, hashEmbedding } from './embeddings';

// ─── Config ───────────────────────────────────────────────────────────────────

import { isPineconeReady, vectorRequest as vectorFetch } from './pinecone-vector';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RagEntry {
  id: string;
  userId: string;
  role: 'user' | 'assistant' | 'memory';
  text: string;
  category?: string;
  importance?: number;
  createdAt: string;
}

export interface RagSearchResult {
  entry: RagEntry;
  /** Combined score: semantic similarity + recency bonus */
  score: number;
  similarity: number;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Store a text snippet in Pinecone Vector.
 * Skips if near-duplicate already exists (similarity > 0.95).
 */
export async function upsertRagEntry(entry: Omit<RagEntry, 'id' | 'createdAt'>): Promise<void> {
  if (!isPineconeReady()) return;

  const text = entry.text.slice(0, 1500);

  const vector = await generateEmbedding(text);

  // Dedup check — query top-1 for this user
  try {
    const existing = await queryRagEntries(entry.userId, text, 1, 0.95);
    if (existing.length > 0) {
      // Near-duplicate — skip
      return;
    }
  } catch {
    // Dedup failed — proceed with upsert anyway
  }

  const id = `${entry.userId}:${entry.role}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  await vectorFetch('/upsert', {
    vectors: [{
      id,
      vector,
      metadata: {
        user_id: entry.userId,
        role: entry.role,
        category: entry.category ?? 'general',
        importance: entry.importance ?? 0.5,
        created_at: now,
      },
      data: text,
    }],
  });
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Semantic search with recency weighting.
 *
 * Score = similarity * 0.75 + recency * 0.25
 * where recency = exp(-age_hours / 168)  (half-life ≈ 1 week)
 */
export async function queryRagEntries(
  userId: string,
  queryText: string,
  topK = 6,
  minSimilarity = 0.45
): Promise<RagSearchResult[]> {
  if (!isPineconeReady() || !userId) return [];

  const semantic = { vector: await generateEmbedding(queryText) };

  let payload: any;
  try {
    payload = await vectorFetch('/query', {
      ...semantic,
      topK: topK * 3, // over-fetch then re-rank
      includeMetadata: true,
      includeData: true,
      filter: { user_id: { $eq: userId } },
    });
  } catch {
    return []; // Fail closed; never retry without the metadata scope.
  }

  const matches: any[] = payload?.result ?? payload?.matches ?? [];
  const now = Date.now();

  const results: RagSearchResult[] = matches
    .filter((m: any) => {
      const uid = m.metadata?.user_id as string | undefined;
      return uid === userId;
    })
    .map((m: any) => {
      const similarity = m.score ?? 0;
      const createdAt = m.metadata?.created_at as string | undefined;
      const ageHours = createdAt
        ? (now - new Date(createdAt).getTime()) / 3_600_000
        : 720; // default 30 days
      const recency = Math.exp(-ageHours / 168); // half-life 1 week
      const importance = (m.metadata?.importance as number | undefined) ?? 0.5;
      const score = similarity * 0.65 + recency * 0.20 + importance * 0.15;

      const entry: RagEntry = {
        id: m.id,
        userId,
        role: (m.metadata?.role as RagEntry['role']) ?? 'user',
        text: typeof m.data === 'string' ? m.data : (m.metadata?.text as string | undefined) ?? '',
        category: m.metadata?.category as string | undefined,
        importance: m.metadata?.importance as number | undefined,
        createdAt: createdAt ?? new Date().toISOString(),
      };

      return { entry, score, similarity };
    })
    .filter(r => r.similarity >= minSimilarity && r.entry.text.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return results;
}

// ─── Convenience wrappers (drop-in replacements for agent-memory.ts) ──────────

export async function queryRagContext(userId: string | undefined, text: string, topK = 4): Promise<string[]> {
  if (!userId) return [];
  try {
    const results = await queryRagEntries(userId, text, topK, 0.40);
    return results.map(r => r.entry.text).filter(Boolean);
  } catch {
    return [];
  }
}

export async function upsertRagMemory(
  userId: string | undefined,
  role: 'user' | 'assistant',
  text: string
): Promise<void> {
  if (!userId) return;
  await upsertRagEntry({ userId, role, text }).catch(() => {});
}
