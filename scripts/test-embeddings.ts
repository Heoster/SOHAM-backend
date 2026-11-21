/** Pinecone embedding dimension regression checks; no network. */
import assert from 'assert';
import { getEmbeddingDimension, generateEmbedding, resetEmbeddingDimensionCache } from '../memory/embeddings';
const env = { ...process.env };
const originalFetch = globalThis.fetch;
async function main() {
  process.env.PINECONE_INDEX_HOST = 'test.svc.pinecone.io';
  process.env.PINECONE_API_KEY = 'test';
  delete process.env.EMBEDDING_DIMS;
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENAI_API_KEY;
  let probes = 0;
  globalThis.fetch = (async (url: any) => {
    assert.ok(String(url).endsWith('/describe_index_stats'));
    probes++;
    return Response.json({ dimension: 64 });
  }) as typeof fetch;
  resetEmbeddingDimensionCache();
  assert.equal(await getEmbeddingDimension(), 64);
  assert.equal((await generateEmbedding('hello Pinecone')).length, 64);
  assert.equal(probes, 1);
  process.env.EMBEDDING_DIMS = '128';
  resetEmbeddingDimensionCache();
  assert.equal(await getEmbeddingDimension(), 128);
  assert.equal(probes, 1);
  console.log('Pinecone embedding dimension checks passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  process.env = env;
  globalThis.fetch = originalFetch;
  resetEmbeddingDimensionCache();
});
