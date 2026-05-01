/**
 * Enhanced RAG Service
 *
 * Combines:
 * - Upstash Vector REST API for semantic short-term search (no SDK dependency)
 * - Supabase REST API for structured long-term memory
 * - Hybrid retrieval: semantic similarity + recency + relevance scoring
 *
 * Memory types:
 * - SHORT_TERM: Recent conversation context (Upstash Vector)
 * - LONG_TERM:  Extracted facts, preferences, skills (Supabase)
 * - REAL_WORLD: Live data from tools (web search, weather, news…)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryChunk {
  id: string;
  content: string;
  type: 'SHORT_TERM' | 'LONG_TERM' | 'REAL_WORLD';
  category?: 'fact' | 'preference' | 'skill' | 'context' | 'knowledge';
  userId: string;
  timestamp: string;
  metadata: {
    source?: string;
    relevanceScore?: number;
    recencyScore?: number;
    semanticScore?: number;
    combinedScore?: number;
  };
}

export interface RAGQuery {
  query: string;
  userId: string;
  topK?: number;
  includeRealWorld?: boolean;
  minSimilarity?: number;
}

export interface RAGResult {
  chunks: MemoryChunk[];
  totalRetrieved: number;
  retrievalTimeMs: number;
  sources: {
    shortTerm: number;
    longTerm: number;
    realWorld: number;
  };
}

// ─── Upstash REST helpers (no SDK) ────────────────────────────────────────────

function getUpstashConfig() {
  return {
    url: (process.env.UPSTASH_VECTOR_REST_URL ?? process.env.UPSTASH_VECTOR_URL ?? '').replace(/\/$/, ''),
    token: process.env.UPSTASH_VECTOR_REST_TOKEN ?? process.env.UPSTASH_VECTOR_TOKEN ?? '',
  };
}

function isUpstashReady(): boolean {
  const { url, token } = getUpstashConfig();
  return Boolean(url && token);
}

async function upstashPost(path: string, body: unknown, timeoutMs = 8000): Promise<any> {
  const { url, token } = getUpstashConfig();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Upstash ${path} ${res.status}: ${err.slice(0, 120)}`);
  }
  return res.json();
}

// ─── Supabase REST helpers ────────────────────────────────────────────────────

function getSupabaseConfig() {
  return {
    url: process.env.SUPABASE_URL ?? '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  };
}

function isSupabaseReady(): boolean {
  const { url, key } = getSupabaseConfig();
  return Boolean(url && key);
}

async function querySupabaseMemories(
  userId: string,
  _query: string,
  limit = 5
): Promise<MemoryChunk[]> {
  if (!isSupabaseReady()) return [];
  const { url, key } = getSupabaseConfig();

  try {
    const res = await fetch(
      `${url}/rest/v1/memories?user_id=eq.${encodeURIComponent(userId)}&select=*&order=created_at.desc&limit=${limit}`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return [];

    const data = await res.json() as any[];
    return data.map(row => ({
      id: row.id,
      content: row.content,
      type: 'LONG_TERM' as const,
      category: (row.category ?? 'fact') as MemoryChunk['category'],
      userId: row.user_id,
      timestamp: row.created_at,
      metadata: {
        source: 'supabase',
        relevanceScore: row.importance ?? 0.5,
      },
    }));
  } catch {
    return [];
  }
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/** Exponential recency decay — half-life 7 days */
function calculateRecencyScore(timestamp: string): number {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = ageMs / 86_400_000;
  return Math.exp(-ageDays / 7);
}

/** Weighted combination: 60% semantic + 25% recency + 15% relevance */
function calculateCombinedScore(
  semanticScore: number,
  recencyScore: number,
  relevanceScore: number
): number {
  return semanticScore * 0.60 + recencyScore * 0.25 + relevanceScore * 0.15;
}

// ─── Main RAG Service ─────────────────────────────────────────────────────────

export class EnhancedRAGService {

  /** Query all memory sources and return ranked results */
  async query(request: RAGQuery): Promise<RAGResult> {
    const startTime = Date.now();
    const { query, userId, topK = 10, includeRealWorld = false, minSimilarity = 0.4 } = request;

    const [shortTermChunks, longTermChunks] = await Promise.all([
      this.queryShortTerm(userId, query, topK, minSimilarity),
      this.queryLongTerm(userId, query, topK),
    ]);

    // REAL_WORLD is reserved for future MCP tool integration
    const realWorldChunks: MemoryChunk[] = includeRealWorld ? [] : [];

    const allChunks = [...shortTermChunks, ...longTermChunks, ...realWorldChunks];

    for (const chunk of allChunks) {
      const recencyScore = calculateRecencyScore(chunk.timestamp);
      const semanticScore = chunk.metadata.semanticScore ?? 0.5;
      const relevanceScore = chunk.metadata.relevanceScore ?? 0.5;
      chunk.metadata.recencyScore = recencyScore;
      chunk.metadata.combinedScore = calculateCombinedScore(semanticScore, recencyScore, relevanceScore);
    }

    allChunks.sort((a, b) => (b.metadata.combinedScore ?? 0) - (a.metadata.combinedScore ?? 0));

    return {
      chunks: allChunks.slice(0, topK),
      totalRetrieved: allChunks.length,
      retrievalTimeMs: Date.now() - startTime,
      sources: {
        shortTerm: shortTermChunks.length,
        longTerm: longTermChunks.length,
        realWorld: realWorldChunks.length,
      },
    };
  }

  /** Query short-term memory via Upstash Vector REST API */
  private async queryShortTerm(
    userId: string,
    query: string,
    topK: number,
    minSimilarity: number
  ): Promise<MemoryChunk[]> {
    if (!isUpstashReady()) return [];

    try {
      let payload: any;
      try {
        payload = await upstashPost('/query', {
          data: query,          // Upstash auto-embeds when using data field
          topK: topK * 2,
          includeMetadata: true,
          includeData: true,
          filter: `user_id = '${userId}'`,
        });
      } catch {
        // Retry without filter (some Upstash plans don't support metadata filters)
        payload = await upstashPost('/query', {
          data: query,
          topK: topK * 4,
          includeMetadata: true,
          includeData: true,
        });
      }

      const matches: any[] = payload?.result ?? payload?.matches ?? [];

      return matches
        .filter((m: any) => {
          const score: number = m.score ?? 0;
          if (score < minSimilarity) return false;
          // Client-side user filter when server-side filter wasn't applied
          const uid = m.metadata?.user_id as string | undefined;
          return uid === userId || String(m.id).startsWith(`${userId}:`);
        })
        .map((m: any) => ({
          id: String(m.id),
          content: typeof m.data === 'string' ? m.data : (m.metadata?.text as string | undefined) ?? '',
          type: 'SHORT_TERM' as const,
          userId,
          timestamp: (m.metadata?.created_at as string | undefined) ?? new Date().toISOString(),
          metadata: {
            source: 'upstash',
            semanticScore: m.score ?? 0,
          },
        }))
        .filter(c => c.content.length > 0)
        .slice(0, topK);
    } catch (error) {
      console.warn('[RAG] Upstash short-term query error:', error);
      return [];
    }
  }

  /** Query long-term memory from Supabase */
  private async queryLongTerm(userId: string, query: string, limit: number): Promise<MemoryChunk[]> {
    return querySupabaseMemories(userId, query, limit);
  }

  /** Store a new memory chunk */
  async store(chunk: Omit<MemoryChunk, 'id' | 'timestamp'>): Promise<void> {
    const id = `${chunk.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();

    // Short-term → Upstash Vector
    if (chunk.type === 'SHORT_TERM' && isUpstashReady()) {
      try {
        await upstashPost('/upsert', {
          vectors: [{
            id,
            data: chunk.content,   // Upstash auto-embeds
            metadata: {
              user_id: chunk.userId,
              type: chunk.type,
              category: chunk.category ?? 'general',
              created_at: timestamp,
              text: chunk.content.slice(0, 1000),
            },
          }],
        });
      } catch (error) {
        console.warn('[RAG] Upstash upsert error:', error);
      }
    }

    // Long-term → Supabase
    if (chunk.type === 'LONG_TERM' && isSupabaseReady()) {
      const { url, key } = getSupabaseConfig();
      try {
        await fetch(`${url}/rest/v1/memories`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            id,
            user_id: chunk.userId,
            content: chunk.content,
            embedding: [],
            category: chunk.category ?? 'FACT',
            importance: chunk.metadata.relevanceScore ?? 0.5,
            tags: [],
            related_ids: [],
            access_count: 0,
            created_at: timestamp,
            last_accessed: timestamp,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        console.warn('[RAG] Supabase insert error:', error);
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _ragService: EnhancedRAGService | null = null;

export function getEnhancedRAGService(): EnhancedRAGService {
  if (!_ragService) _ragService = new EnhancedRAGService();
  return _ragService;
}
