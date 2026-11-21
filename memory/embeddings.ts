/** Shared dimension-pinned embeddings for Pinecone and local memory. */

// ─── Hash embedding (deterministic, offline, any dimension) ──────────────────

export function hashEmbedding(text: string, dimensions = 512): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    vec[h % dimensions] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  // 7 decimals ≈ float32 precision; keeps JSON payloads small (~30% less) —
  // Pinecone rejects oversized request bodies and stores float32 anyway.
  return vec.map(v => Math.round((v / norm) * 1e7) / 1e7);
}

// ─── Index dimension detection (cached) ───────────────────────────────────────

let cachedDim: number | null = null;

/** Test hook — clears the cached dimension. */
export function resetEmbeddingDimensionCache(): void {
  cachedDim = null;
}

function readDimension(info: any): number | null {
  const candidates = [
    info?.result?.dimension,
    info?.result?.vectorDimension,
    info?.dimension,
    info?.vectorDimension,
    info?.index?.dimension,
  ];
  for (const c of candidates) {
    const d = Number(c);
    if (Number.isFinite(d) && d > 0) return Math.floor(d);
  }
  return null;
}

/**
 * The dimension the Pinecone index was created with. Every vector we upsert or
 * query MUST have exactly this length.
 */
export async function getEmbeddingDimension(): Promise<number> {
  if (cachedDim) return cachedDim;

  const envDim = Number(process.env.EMBEDDING_DIMS ?? '');
  if (Number.isFinite(envDim) && envDim > 0) {
    return (cachedDim = Math.floor(envDim));
  }

  const { isPineconeReady, pineconeRequest } = await import('./pinecone-vector');
  if (isPineconeReady()) {
    const stats = await pineconeRequest('/describe_index_stats', {});
    const dim = readDimension(stats);
    if (!dim) throw new Error('Pinecone did not report an index dimension; set EMBEDDING_DIMS');
    return (cachedDim = dim);
  }
  return (cachedDim = 512);
}

// ─── Semantic embedding (Google gemini-embedding-001, MRL) ────────────────────

function truncateToDimension(values: number[], dim: number): number[] | null {
  // JSON.stringify(NaN) -> "null" -> Pinecone 400 "Missing or wrong input".
  // Never let a non-finite value reach the wire.
  const sliced = values.slice(0, dim).map(v => (Number.isFinite(v) ? v : 0));
  const norm = Math.sqrt(sliced.reduce((s, v) => s + v * v, 0));
  if (norm === 0 || !Number.isFinite(norm)) return null;   // all-unusable → caller falls back to hash
  return sliced.map(v => Math.round((v / norm) * 1e7) / 1e7);   // quantize — see hashEmbedding
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const dim = await getEmbeddingDimension();
  const key = process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

  if (key) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text: text.slice(0, 2000) }] },
            outputDimensionality: dim,
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (res.ok) {
        const data = await res.json() as any;
        const values: number[] | undefined = data?.embedding?.values;
        if (Array.isArray(values) && values.length >= dim) {
          const truncated = truncateToDimension(values, dim);
          if (truncated) return truncated;
          console.warn('[Embedding] Google vector unusable (non-finite) — using hash fallback');
        }
        console.warn(`[Embedding] Google returned ${values?.length ?? 0}-dim vector for a ${dim}-dim index — using hash fallback`);
      } else {
        console.warn(`[Embedding] Google API error ${res.status} — falling back to hash embedding at ${dim} dims`);
      }
    } catch (err) {
      console.warn('[Embedding] Google embedding request failed — using hash fallback', err instanceof Error ? err.message : err);
    }
  }
  return hashEmbedding(text, dim);
}
