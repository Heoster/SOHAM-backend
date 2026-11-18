import { randomUUID } from 'crypto';

export interface CrossDeviceMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
}

interface VectorMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
  data?: string;
}

function getSupabaseConfig() {
  return {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  };
}

function getUpstashConfig() {
  return {
    url: process.env.UPSTASH_VECTOR_REST_URL || process.env.UPSTASH_VECTOR_URL || '',
    token: process.env.UPSTASH_VECTOR_REST_TOKEN || process.env.UPSTASH_VECTOR_TOKEN || '',
  };
}

function isSupabaseConfigured(): boolean {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
}

function isUpstashConfigured(): boolean {
  const cfg = getUpstashConfig();
  return Boolean(cfg.url && cfg.token);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { cache: _cache, ...rest } = init as any;
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Embeddings ───────────────────────────────────────────────────────────────
// Shared implementation (dimension-pinned, see ./embeddings for the why).
export { generateEmbedding, hashEmbedding } from './embeddings';
import { generateEmbedding } from './embeddings';
// ─── Cross-device history (Supabase) ─────────────────────────────────────────

export async function loadCrossDeviceHistory(userId?: string, limit = 8): Promise<CrossDeviceMessage[]> {
  if (!userId || !isSupabaseConfigured()) return [];
  const { url, key } = getSupabaseConfig();
  const endpoint =
    `${url}/rest/v1/chat_history?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=role,content,created_at&order=created_at.desc&limit=${Math.max(1, Math.min(limit, 20))}`;
  try {
    const response = await fetchWithTimeout(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return [];
    const rows = (await response.json()) as CrossDeviceMessage[];
    return rows.reverse();
  } catch {
    return [];
  }
}

export async function persistCrossDeviceHistory(
  userId: string | undefined,
  userMessage: string,
  assistantMessage: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!userId || !isSupabaseConfigured()) return;
  const { url, key } = getSupabaseConfig();
  const records = [
    { user_id: userId, role: 'user', content: userMessage, metadata: metadata || {} },
    { user_id: userId, role: 'assistant', content: assistantMessage, metadata: metadata || {} },
  ];
  try {
    await fetchWithTimeout(`${url}/rest/v1/chat_history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(records),
    });
  } catch {
    // fail open
  }
}

// ─── RAG context (Upstash Vector) ─────────────────────────────────────────────

/**
 * Query Upstash Vector for semantically similar past messages.
 * Uses real Google embeddings when available, hash-embedding as fallback.
 * Applies recency weighting: recent memories score higher.
 */
export async function queryRagContext(userId: string | undefined, text: string, topK = 5): Promise<string[]> {
  if (!userId || !isUpstashConfigured()) return [];
  const { url, token } = getUpstashConfig();

  const vector = await generateEmbedding(text);

  try {
    const response = await fetchWithTimeout(
      `${url.replace(/\/$/, '')}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vector, topK: topK * 3, includeMetadata: true, includeData: true }),
      },
      8000
    );
    if (!response.ok) return [];

    const payload = (await response.json()) as { result?: VectorMatch[]; matches?: VectorMatch[] };
    const matches = payload.result || payload.matches || [];

    const now = Date.now();

    // Filter to this user, apply recency weighting, re-rank
    const scored = matches
      .filter(m => {
        const uid = m.metadata?.user_id as string | undefined;
        return uid === userId || String(m.id).startsWith(`${userId}:`);
      })
      .map(m => {
        const semanticScore = m.score ?? 0;
        // Recency: decay over 7 days (604800000 ms)
        const createdAt = m.metadata?.created_at as string | undefined;
        const ageMs = createdAt ? now - new Date(createdAt).getTime() : 7 * 24 * 3600 * 1000;
        const recencyScore = Math.exp(-ageMs / (7 * 24 * 3600 * 1000)); // 0–1, 1 = just now
        const finalScore = semanticScore * 0.75 + recencyScore * 0.25;
        const text = typeof m.data === 'string' ? m.data : (m.metadata?.text as string | undefined) || '';
        return { text, finalScore };
      })
      .filter(m => m.text.length > 0)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, topK)
      .map(m => m.text);

    return scored;
  } catch {
    return [];
  }
}

/**
 * Upsert a message into Upstash Vector using real embeddings.
 */
export async function upsertRagMemory(
  userId: string | undefined,
  role: 'user' | 'assistant',
  text: string
): Promise<void> {
  if (!userId || !isUpstashConfigured() || text.trim().length < 10) return;
  const { url, token } = getUpstashConfig();
  const id = `${userId}:${role}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const vector = await generateEmbedding(text);

  try {
    await fetchWithTimeout(
      `${url.replace(/\/$/, '')}/upsert`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vectors: [{
            id,
            vector,
            metadata: {
              user_id: userId,
              role,
              text: text.slice(0, 1000),
              created_at: new Date().toISOString(),
            },
            data: text.slice(0, 1200),
          }],
        }),
      },
      8000
    );
  } catch {
    // fail open
  }
}
