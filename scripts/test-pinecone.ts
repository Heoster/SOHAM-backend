/** Pinecone API contract and application RAG checks; no credentials/network required. */
import assert from 'assert';
import { vectorRequest, isPineconeReady, pineconeRequest } from '../memory/pinecone-vector';
import { upsertRagEntry, queryRagEntries } from '../memory/enhanced-rag';
const env = { ...process.env };
const originalFetch = globalThis.fetch;
async function main() {
  delete process.env.PINECONE_INDEX_HOST;
  delete process.env.PINECONE_API_KEY;
  process.env.UPSTASH_VECTOR_REST_URL = 'https://obsolete.example';
  process.env.UPSTASH_VECTOR_REST_TOKEN = 'obsolete';
  assert.equal(isPineconeReady(), false, 'old Upstash credentials must not enable storage');
  process.env.PINECONE_INDEX_HOST = 'test.svc.pinecone.io';
  process.env.PINECONE_API_KEY = 'unit-key';
  process.env.PINECONE_NAMESPACE = 'unit';
  process.env.EMBEDDING_DIMS = '64';
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENAI_API_KEY;
  const calls: { url: string; body: any }[] = [];
  let matches: any[] = [];
  let failQuery = false;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith('https://test.svc.pinecone.io/'));
    assert.equal((init?.headers as any)['Api-Key'], 'unit-key');
    assert.equal((init?.headers as any).Authorization, undefined);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.endsWith('/query')) return Response.json({ matches }, { status: failQuery ? 503 : 200 });
    if (url.includes('/vectors/fetch')) {
      assert.equal(init?.method, undefined);
      assert.ok(url.includes('namespace=unit'));
      return Response.json({ vectors: { a: { id: 'a', metadata: { _soham_text: 'saved text' } } } });
    }
    return Response.json({});
  }) as typeof fetch;
  await vectorRequest('/upsert', { vectors: [{ id: 'a', vector: [1, 0], data: 'saved text', metadata: { nil: undefined } }] });
  assert.deepEqual(calls[0].body, { namespace: 'unit', vectors: [{ id: 'a', values: [1, 0], metadata: { _soham_text: 'saved text' } }] });
  matches = [{ id: 'a', score: 0.9, metadata: { _soham_text: 'saved text' } }];
  const result = await vectorRequest('/query', { vector: [1, 0], topK: 2, filter: "namespace = 'public'" });
  assert.equal(result.result[0].data, 'saved text');
  assert.deepEqual(calls.at(-1)!.body.filter, { namespace: { $eq: 'public' } });
  assert.equal((await vectorRequest('/fetch', { ids: ['a'] })).result[0].data, 'saved text');
  await vectorRequest('/update', { id: 'a', metadata: { usage_count: 2 } });
  assert.deepEqual(calls.at(-1)!.body.setMetadata, { usage_count: 2 });
  await vectorRequest('/delete', { ids: ['a'] });
  assert.deepEqual(calls.at(-1)!.body, { namespace: 'unit', ids: ['a'] });
  matches = [];
  await upsertRagEntry({ userId: "user'one", role: 'user', text: 'Remember my preferred programming language' });
  assert.equal(calls.at(-1)!.body.vectors[0].values.length, 64);
  assert.equal(calls.at(-1)!.body.vectors[0].metadata.user_id, "user'one");
  matches = [{ id: 'foreign', score: 1, metadata: { user_id: 'other', _soham_text: 'secret' } }];
  assert.deepEqual(await queryRagEntries("user'one", 'language'), []);
  assert.deepEqual(calls.at(-1)!.body.filter, { user_id: { $eq: "user'one" } });
  failQuery = true;
  const before = calls.length;
  assert.deepEqual(await queryRagEntries('user', 'test'), []);
  assert.equal(calls.length, before + 1, 'never retry an unscoped query');
  process.env.PINECONE_INDEX_HOST = 'https://attacker.example';
  await assert.rejects(pineconeRequest('/query', {}), /Pinecone HTTPS/);
  console.log('Pinecone API contract and RAG isolation checks passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  process.env = env;
  globalThis.fetch = originalFetch;
});
