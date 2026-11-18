/**
 * Embeddings dimension regression checks (no network — fetch is stubbed).
 *
 * Upstash Vector rejects wrong-shaped vectors with
 *   400 Missing or wrong input at [... column: N]
 * gemini-embedding-001 defaults to 3072 dims, so EVERY path must send vectors
 * pre-sized to the index dimension (EMBEDDING_DIMS → /info → fallback).
 */
import assert from 'assert';
import {
  generateEmbedding,
  hashEmbedding,
  getEmbeddingDimension,
  resetEmbeddingDimensionCache,
} from '../memory/embeddings';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

type FetchStub = (url: string, init?: any) => Promise<Response>;

function stubFetch(stub: FetchStub) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    return stub(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function reset() {
  process.env = { ...originalEnv };
  resetEmbeddingDimensionCache();
}

async function main() {
  // ── 1) hashEmbedding is deterministic + unit-norm at any dimension ─────────
  const h1 = hashEmbedding('hello soham', 1536);
  const h2 = hashEmbedding('hello soham', 1536);
  assert.equal(h1.length, 1536);
  assert.deepEqual(h1, h2);
  const norm = Math.sqrt(h1.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `hash embedding must be unit-norm, got ${norm}`);

  // ── 2) EMBEDDING_DIMS env var wins; Google request carries outputDimensionality ──
  await reset();
  setEnv({ EMBEDDING_DIMS: '1536', GOOGLE_AI_API_KEY: 'test-google-key', UPSTASH_VECTOR_REST_URL: 'https://uvt.example.com', UPSTASH_VECTOR_REST_TOKEN: 'tok' });
  let googleBody: any = null;
  stubFetch(async (url, init) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      googleBody = JSON.parse(String(init?.body));
      return jsonResponse({ embedding: { values: Array.from({ length: 3072 }, (_, i) => Math.sin(i)) } });
    }
    if (url.includes('/info')) {
      return jsonResponse({ result: { dimension: 999 } }); // must be ignored — env wins
    }
    throw new Error('unexpected fetch: ' + url);
  });
  const v1 = await generateEmbedding('hello');
  assert.equal(googleBody?.outputDimensionality, 1536, 'Google call must pin outputDimensionality');
  assert.equal(v1.length, 1536, 'client-side MRL truncation must yield the index dimension');
  const n1 = Math.sqrt(v1.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(n1 - 1) < 1e-6, 'truncated embedding must be re-normalized');

  // ── 2b) Non-finite values from Google → hash fallback (never null on the wire) ──
  await reset();
  setEnv({ EMBEDDING_DIMS: '512', GOOGLE_AI_API_KEY: 'test-google-key', UPSTASH_VECTOR_REST_URL: undefined, UPSTASH_VECTOR_REST_TOKEN: undefined });
  stubFetch(async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({ embedding: { values: [NaN, Infinity, -Infinity, ...Array.from({ length: 509 }, () => 0.001)] } });
    }
    throw new Error('unexpected fetch: ' + url);
  });
  const v2b = await generateEmbedding('nan test');
  assert.equal(v2b.length, 512);
  assert.ok(v2b.every(Number.isFinite), 'no NaN/Infinity may survive');

  // ── 3) No env var → /info probe determines the dimension ───────────────────
  await reset();
  setEnv({ EMBEDDING_DIMS: undefined, GOOGLE_AI_API_KEY: 'test-google-key', UPSTASH_VECTOR_REST_URL: 'https://uvt.example.com', UPSTASH_VECTOR_REST_TOKEN: 'tok' });
  stubFetch(async (url) => {
    if (url.includes('/info')) return jsonResponse({ result: { dimension: 768 } });
    if (url.includes('generativelanguage.googleapis.com')) return jsonResponse({ embedding: { values: Array.from({ length: 768 }, () => 0.01) } });
    throw new Error('unexpected fetch: ' + url);
  });
  assert.equal(await getEmbeddingDimension(), 768);
  assert.equal((await generateEmbedding('x')).length, 768);

  // ── 4) /info down + Google down → hash fallback at the PROBED dim ─────────
  await reset();
  setEnv({ EMBEDDING_DIMS: undefined, GOOGLE_AI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_GENAI_API_KEY: undefined, UPSTASH_VECTOR_REST_URL: 'https://uvt.example.com', UPSTASH_VECTOR_REST_TOKEN: 'tok' });
  stubFetch(async (url) => {
    if (url.includes('/info')) return jsonResponse({}, 500); // unreadable
    throw new Error('unexpected fetch: ' + url);
  });
  const dim4 = await getEmbeddingDimension();
  assert.equal(dim4, 512, 'unkeyed + unreadable /info must keep the historical 512-dim hash shape');
  assert.equal((await generateEmbedding('x')).length, 512);

  // ── 5) Google API errors → hash fallback at the index dimension ────────────
  await reset();
  setEnv({ EMBEDDING_DIMS: '1024', GOOGLE_AI_API_KEY: 'test-google-key', UPSTASH_VECTOR_REST_URL: undefined, UPSTASH_VECTOR_REST_TOKEN: undefined });
  stubFetch(async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) return jsonResponse({ error: 'bad key' }, 400);
    throw new Error('unexpected fetch: ' + url);
  });
  const v5 = await generateEmbedding('fallback please');
  assert.equal(v5.length, 1024, 'hash fallback must match the configured index dimension');

  // ── 6) Dimension cache is per-process (and resettable for tests) ───────────
  await reset();
  setEnv({ EMBEDDING_DIMS: '1536', GOOGLE_AI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_GENAI_API_KEY: undefined, UPSTASH_VECTOR_REST_URL: undefined, UPSTASH_VECTOR_REST_TOKEN: undefined });
  stubFetch(async () => { throw new Error('no network expected'); });
  assert.equal(await getEmbeddingDimension(), 1536);
  setEnv({ EMBEDDING_DIMS: '777' });
  assert.equal(await getEmbeddingDimension(), 1536, 'second read must come from cache');
  resetEmbeddingDimensionCache();
  assert.equal(await getEmbeddingDimension(), 777, 'after reset the env override applies');

  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  console.log('embeddings checks passed ✔');
}

main().catch(err => {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
