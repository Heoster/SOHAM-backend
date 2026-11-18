/**
 * Shared Embeddings — single source of truth for the whole codebase.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * An Upstash Vector index has a FIXED dimension chosen at creation time; a
 * vector with any other length is rejected with `400 Missing or wrong input`.
 * `gemini-embedding-001` defaults to 3072 dimensions, and the code paths that
 * don't pin `outputDimensionality` silently produce vectors of whatever the
 * API default is — which is why stores/queries intermittently failed.
 *
 * The index dimension is resolved (in priority order):
 *   1. EMBEDDING_DIMS env var          — explicit operator override
 *   2. `GET {UPSTASH_VECTOR_*}/info`   — probed once, cached (reports e.g. {"result":{"dimension":N}})
 *   3. 3072 (keyed) / 512 (unkeyed)    — preserves historical behaviour
 *
 * gemini-embedding-001 is a Matryoshka (MRL) model, so requesting a smaller
 * `outputDimensionality` yields a truncated, re-normalized vector whose
 * geometry is still valid. If Google ever returns a different length anyway,
 * we truncate + re-normalize client-side rather than send a wrong-shaped
 * vector to the index. The hash fallback always matches the index dimension.
 */

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
  return vec.map(v => v / norm);
}

// ─── Index dimension detection (cached) ───────────────────────────────────────

let cachedDim: number | null = null;

/** Test hook — clears the cached dimension. */
export function resetEmbeddingDimensionCache(): void {
  cachedDim = null;
}

function getUpstashBase(): { url: string; token: string } {
  return {
    url: (process.env.UPSTASH_VECTOR_REST_URL || process.env.UPSTASH_VECTOR_URL || '').replace(/\/$/, ''),
    token: process.env.UPSTASH_VECTOR_REST_TOKEN || process.env.UPSTASH_VECTOR_TOKEN || '',
  };
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
 * The dimension the Upstash index was created with. Every vector we upsert or
 * query MUST have exactly this length.
 */
export async function getEmbeddingDimension(): Promise<number> {
  if (cachedDim) return cachedDim;

  const envDim = Number(process.env.EMBEDDING_DIMS ?? '');
  if (Number.isFinite(envDim) && envDim > 0) {
    return (cachedDim = Math.floor(envDim));
  }

  const { url, token } = getUpstashBase();
  const hasGoogleKey = Boolean(process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY);
  // Historical behaviour: no Google key → 512-dim hash vectors; with Google key →
  // gemini-embedding-001 API default (3072). Keep those as last-resort defaults
  // when neither EMBEDDING_DIMS nor the /info probe can tell us the true dim.
  const fallbackDim = hasGoogleKey ? 3072 : 512;

  if (url && token) {
    try {
      const res = await fetch(`${url}/info`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const dim = readDimension(await res.json());
        if (dim) {
          console.log(`[Embedding] Upstash index dimension is ${dim} (via /info)`);
          return (cachedDim = dim);
        }
        console.warn(`[Embedding] Upstash /info did not report a dimension — using default ${fallbackDim}. Set EMBEDDING_DIMS to override.`);
      } else {
        console.warn(`[Embedding] Upstash /info returned ${res.status} — using default ${fallbackDim}. Set EMBEDDING_DIMS to override.`);
      }
    } catch (err) {
      console.warn(`[Embedding] Could not probe Upstash /info — using default ${fallbackDim}. Set EMBEDDING_DIMS to override.`, err instanceof Error ? err.message : err);
    }
  }
  return (cachedDim = fallbackDim);
}

// ─── Semantic embedding (Google gemini-embedding-001, MRL) ────────────────────

function truncateToDimension(values: number[], dim: number): number[] | null {
  // JSON.stringify(NaN) -> "null" -> Upstash 400 "Missing or wrong input".
  // Never let a non-finite value reach the wire.
  const sliced = values.slice(0, dim).map(v => (Number.isFinite(v) ? v : 0));
  const norm = Math.sqrt(sliced.reduce((s, v) => s + v * v, 0));
  if (norm === 0 || !Number.isFinite(norm)) return null;   // all-unusable → caller falls back to hash
  return sliced.map(v => v / norm);
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
