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
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

function isSupabaseConfigured(): boolean {
  const cfg = getSupabaseConfig();
  return Boolean(cfg.url && cfg.key);
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
    `&select=user_id,role,content,created_at&order=created_at.desc&limit=${Math.max(1, Math.min(limit, 20))}`;
  try {
    const response = await fetchWithTimeout(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return [];
    const rows = (await response.json()) as CrossDeviceMessage[];
    return rows.filter(row => (row as CrossDeviceMessage & { user_id?: string }).user_id === userId && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string').reverse().map(({ role, content, created_at }) => ({ role, content, created_at }));
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

// ─── RAG context (Pinecone Vector) ─────────────────────────────────────────────

/**
 * Query Pinecone Vector for semantically similar past messages.
 * Uses real Google embeddings when available, hash-embedding as fallback.
 * Applies recency weighting: recent memories score higher.
 */
export { queryRagContext, upsertRagMemory } from './enhanced-rag';
