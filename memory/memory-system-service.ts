/**
 * Memory System Service
 * ════════════════════════════════════════════════════════════════════════════
 * Vector-based long-term memory for SOHAM.
 *
 * Storage backend: Supabase PostgreSQL (REST API — no SDK, no Firebase)
 * Embeddings:      Google gemini-embedding-001 (or fallback hash-embedding)
 *
 * Table schema (run once in Supabase SQL editor):
 * ─────────────────────────────────────────────────────────────────────────
 *   CREATE TABLE IF NOT EXISTS memories (
 *     id              TEXT PRIMARY KEY,
 *     user_id         TEXT NOT NULL,
 *     content         TEXT NOT NULL,
 *     embedding       JSONB NOT NULL DEFAULT '[]',
 *     category        TEXT NOT NULL DEFAULT 'CONVERSATION',
 *     importance      FLOAT NOT NULL DEFAULT 0.5,
 *     tags            JSONB NOT NULL DEFAULT '[]',
 *     related_ids     JSONB NOT NULL DEFAULT '[]',
 *     access_count    INTEGER NOT NULL DEFAULT 0,
 *     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     last_accessed   TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 *   CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories (user_id);
 *   CREATE INDEX IF NOT EXISTS memories_category_idx ON memories (user_id, category);
 *   CREATE INDEX IF NOT EXISTS memories_last_accessed_idx ON memories (user_id, last_accessed);
 *
 *   ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "service role full access" ON memories USING (true) WITH CHECK (true);
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Features:
 *   - Store / update / delete memories
 *   - Cosine similarity search (in-process, no pgvector needed)
 *   - Category filtering
 *   - Importance scoring
 *   - Access tracking
 *   - Prune old memories
 *   - Consolidate duplicates
 *   - Graceful degradation when Supabase is not configured
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryCategory =
  | 'PREFERENCE'    // User preferences ("prefers concise responses")
  | 'FACT'          // Facts about the user ("works as a software engineer")
  | 'CONTEXT'       // Contextual info ("working on a React project")
  | 'SKILL'         // User skills ("expert in TypeScript")
  | 'CONVERSATION'; // Important conversation snippets

export interface MemoryMetadata {
  category: MemoryCategory;
  importance: number;           // 0–1
  tags: string[];
  relatedMemoryIds?: string[];
}

export interface MemoryEntry {
  id: string;
  userId: string;
  content: string;
  embedding: number[];
  metadata: MemoryMetadata;
  createdAt: string;            // ISO string
  lastAccessed: string;         // ISO string
  accessCount: number;
}

export interface MemoryQuery {
  userId: string;
  queryText: string;
  topK?: number;
  minSimilarity?: number;
  categories?: MemoryCategory[];
}

export interface MemorySearchResult {
  memory: MemoryEntry;
  similarity: number;
  relevanceScore: number;
}

// ─── Supabase REST helpers ────────────────────────────────────────────────────

interface SupabaseConfig {
  url: string;
  key: string;
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function isConfigured(): boolean {
  return getSupabaseConfig() !== null;
}

async function sbFetch(
  path: string,
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${cfg.url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(tid);
  }
}

// ─── Row shape (Supabase snake_case) ─────────────────────────────────────────

interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  embedding: number[];
  category: MemoryCategory;
  importance: number;
  tags: string[];
  related_ids: string[];
  access_count: number;
  created_at: string;
  last_accessed: string;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    embedding: row.embedding ?? [],
    metadata: {
      category: row.category,
      importance: row.importance,
      tags: row.tags ?? [],
      relatedMemoryIds: row.related_ids ?? [],
    },
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
  };
}

// ─── Fallback hash-embedding (no API key needed) ──────────────────────────────

function hashEmbedding(text: string, dimensions = 512): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    vec[h % dimensions] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

// ─── Memory System Service ────────────────────────────────────────────────────

export class MemorySystemService {
  private readonly table = 'memories';

  // ── Storage ────────────────────────────────────────────────────────────────

  async storeMemory(
    userId: string,
    content: string,
    metadata: MemoryMetadata
  ): Promise<MemoryEntry> {
    if (!isConfigured()) {
      console.warn('[MemorySystem] Supabase not configured — memory not stored');
      return this._makeLocalEntry(userId, content, metadata);
    }

    const embedding = await this.generateEmbedding(content);
    const id = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const row: MemoryRow = {
      id,
      user_id: userId,
      content,
      embedding,
      category: metadata.category,
      importance: metadata.importance,
      tags: metadata.tags,
      related_ids: metadata.relatedMemoryIds ?? [],
      access_count: 0,
      created_at: now,
      last_accessed: now,
    };

    const res = await sbFetch(this.table, {
      method: 'POST',
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to store memory: ${err}`);
    }

    const [stored] = await res.json() as MemoryRow[];
    return rowToEntry(stored ?? row);
  }

  async updateMemory(
    memoryId: string,
    updates: Partial<Omit<MemoryEntry, 'id' | 'userId' | 'createdAt'>>
  ): Promise<void> {
    if (!isConfigured()) return;

    const patch: Partial<MemoryRow> = {};
    if (updates.content !== undefined) patch.content = updates.content;
    if (updates.accessCount !== undefined) patch.access_count = updates.accessCount;
    if (updates.lastAccessed !== undefined) patch.last_accessed = updates.lastAccessed;
    if (updates.embedding !== undefined) patch.embedding = updates.embedding;
    if (updates.metadata) {
      if (updates.metadata.category !== undefined) patch.category = updates.metadata.category;
      if (updates.metadata.importance !== undefined) patch.importance = updates.metadata.importance;
      if (updates.metadata.tags !== undefined) patch.tags = updates.metadata.tags;
      if (updates.metadata.relatedMemoryIds !== undefined) patch.related_ids = updates.metadata.relatedMemoryIds;
    }

    const res = await sbFetch(`${this.table}?id=eq.${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[MemorySystem] updateMemory failed: ${err}`);
    }
  }

  async deleteMemory(memoryId: string): Promise<void> {
    if (!isConfigured()) return;

    const res = await sbFetch(`${this.table}?id=eq.${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[MemorySystem] deleteMemory failed: ${err}`);
    }
  }

  async deleteAllUserMemories(userId: string): Promise<number> {
    if (!isConfigured()) return 0;

    // Count first
    const countRes = await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}&select=id`,
      { method: 'GET', headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
    );
    const countHeader = countRes.headers.get('content-range') ?? '';
    const total = parseInt(countHeader.split('/')[1] ?? '0', 10) || 0;

    const delRes = await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    );

    if (!delRes.ok) {
      const err = await delRes.text();
      console.warn(`[MemorySystem] deleteAllUserMemories failed: ${err}`);
      return 0;
    }

    return total;
  }

  // ── Retrieval ──────────────────────────────────────────────────────────────

  async searchMemories(queryParams: MemoryQuery): Promise<MemorySearchResult[]> {
    const { userId, queryText, topK = 5, minSimilarity = 0.5, categories } = queryParams;

    if (!isConfigured()) return [];

    const queryEmbedding = await this.generateEmbedding(queryText);

    // Build filter URL
    let url = `${this.table}?user_id=eq.${encodeURIComponent(userId)}&select=*&order=last_accessed.desc&limit=200`;
    if (categories && categories.length > 0) {
      url += `&category=in.(${categories.map(c => encodeURIComponent(c)).join(',')})`;
    }

    const res = await sbFetch(url, { method: 'GET', headers: { Prefer: 'return=representation' } });
    if (!res.ok) return [];

    const rows = await res.json() as MemoryRow[];

    const results: MemorySearchResult[] = rows
      .map(row => {
        const memory = rowToEntry(row);
        const similarity = this.calculateSimilarity(queryEmbedding, memory.embedding);
        const relevanceScore = similarity * 0.7 + memory.metadata.importance * 0.3;
        return { memory, similarity, relevanceScore };
      })
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);

    // Update access counts non-blocking
    const now = new Date().toISOString();
    for (const r of results) {
      this.updateMemory(r.memory.id, {
        accessCount: r.memory.accessCount + 1,
        lastAccessed: now,
      }).catch(() => {});
    }

    return results;
  }

  async getRecentMemories(userId: string, limitCount = 10): Promise<MemoryEntry[]> {
    if (!isConfigured()) return [];

    const res = await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}&select=*&order=created_at.desc&limit=${limitCount}`,
      { method: 'GET' }
    );
    if (!res.ok) return [];

    const rows = await res.json() as MemoryRow[];
    return rows.map(rowToEntry);
  }

  async getMemoriesByCategory(userId: string, category: MemoryCategory): Promise<MemoryEntry[]> {
    if (!isConfigured()) return [];

    const res = await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}&category=eq.${encodeURIComponent(category)}&select=*&order=importance.desc`,
      { method: 'GET' }
    );
    if (!res.ok) return [];

    const rows = await res.json() as MemoryRow[];
    return rows.map(rowToEntry);
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────

  /**
   * Generate embedding via Google gemini-embedding-001.
   * Falls back to a deterministic hash-embedding if the API key is missing.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      // Graceful fallback — no crash, just lower quality similarity
      return hashEmbedding(text);
    }

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
          signal: AbortSignal.timeout(8000),
        }
      );

      if (!res.ok) {
        console.warn(`[MemorySystem] Embedding API error ${res.status} — using hash fallback`);
        return hashEmbedding(text);
      }

      const data = await res.json() as any;
      return data?.embedding?.values ?? hashEmbedding(text);
    } catch {
      return hashEmbedding(text);
    }
  }

  /**
   * Cosine similarity, normalized to 0–1.
   */
  calculateSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    // If dimensions differ (hash vs real embedding), pad shorter with zeros
    const len = Math.max(a.length, b.length);
    const va = a.length < len ? [...a, ...new Array(len - a.length).fill(0)] : a;
    const vb = b.length < len ? [...b, ...new Array(len - b.length).fill(0)] : b;

    let dot = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < len; i++) {
      dot += va[i] * vb[i];
      n1 += va[i] * va[i];
      n2 += vb[i] * vb[i];
    }
    const mag = Math.sqrt(n1) * Math.sqrt(n2);
    if (mag === 0) return 0;
    return (dot / mag + 1) / 2; // normalize -1..1 → 0..1
  }

  // ── Context injection ──────────────────────────────────────────────────────

  injectMemoriesIntoPrompt(prompt: string, memories: MemorySearchResult[]): string {
    if (memories.length === 0) return prompt;

    const ctx = memories
      .map((r, i) =>
        `[Memory ${i + 1}] (${r.memory.metadata.category}, importance: ${r.memory.metadata.importance.toFixed(2)}): ${r.memory.content}`
      )
      .join('\n');

    return `Context from previous interactions:\n${ctx}\n\nCurrent request:\n${prompt}`;
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  async pruneOldMemories(userId: string, olderThanDays = 90): Promise<number> {
    if (!isConfigured()) return 0;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffIso = cutoff.toISOString();

    // Count
    const countRes = await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}&last_accessed=lt.${encodeURIComponent(cutoffIso)}&select=id`,
      { method: 'GET', headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
    );
    const countHeader = countRes.headers.get('content-range') ?? '';
    const total = parseInt(countHeader.split('/')[1] ?? '0', 10) || 0;

    // Delete
    await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}&last_accessed=lt.${encodeURIComponent(cutoffIso)}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    );

    return total;
  }

  async consolidateMemories(userId: string): Promise<void> {
    const memories = await this.getRecentMemories(userId, 100);
    const groups: MemoryEntry[][] = [];

    for (const mem of memories) {
      let placed = false;
      for (const group of groups) {
        if (this.calculateSimilarity(mem.embedding, group[0].embedding) > 0.9) {
          group.push(mem);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push([mem]);
    }

    for (const group of groups) {
      if (group.length <= 1) continue;
      group.sort((a, b) => {
        const sa = a.metadata.importance * 0.7 + (a.accessCount / 100) * 0.3;
        const sb = b.metadata.importance * 0.7 + (b.accessCount / 100) * 0.3;
        return sb - sa;
      });
      for (let i = 1; i < group.length; i++) {
        await this.deleteMemory(group[i].id).catch(() => {});
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _makeLocalEntry(userId: string, content: string, metadata: MemoryMetadata): MemoryEntry {
    const now = new Date().toISOString();
    return {
      id: `local_${Date.now()}`,
      userId,
      content,
      embedding: hashEmbedding(content),
      metadata,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: MemorySystemService | null = null;

export function getMemorySystemService(): MemorySystemService {
  if (!_instance) _instance = new MemorySystemService();
  return _instance;
}

export function resetMemorySystemService(): void {
  _instance = null;
}
