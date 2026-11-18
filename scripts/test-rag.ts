/**
 * Document RAG regression checks (no network — fetch is stubbed).
 * Covers: chunker, ingest → search → delete round-trip, user isolation,
 * and the plain-text extraction path.
 */
import assert from 'assert';
import { chunkText, ingestDocument, searchDocuments, listDocuments, deleteDocument } from '../memory/document-rag';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

type Vec = { id: string; vector: number[]; metadata: any; data?: string };
const store = new Map<string, Vec>();

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function filterMatch(metadata: any, filter?: string): boolean {
  if (!filter) return true;
  const andParts = filter.split(/\s+AND\s+/i);
  return andParts.every(part => {
    const m = part.trim().match(/^(\w+)\s*=\s*'([^']*)'$/);
    if (!m) return true;
    return String(metadata?.[m[1]] ?? '') === m[2];
  });
}

async function stubbedFetch(input: any, init?: any): Promise<Response> {
  const url = String(input?.url ?? input);
  const method = String(init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  if (url.includes('/upsert') && method === 'POST') {
    for (const v of body.vectors ?? []) store.set(v.id, v);
    return json({ result: 'Ok' });
  }
  if (url.includes('/query') && method === 'POST') {
    const topK = Number(body.topK ?? 4);
    const matches = [...store.values()]
      .filter(v => filterMatch(v.metadata, body.filter))
      .map(v => ({ id: v.id, score: cosine(body.vector, v.vector), metadata: v.metadata, data: v.data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return json({ result: matches });
  }
  if (url.includes('/delete') && method === 'POST') {
    for (const id of body.ids ?? []) store.delete(id);
    return json({ result: 'Ok' });
  }
  throw new Error(`unexpected fetch: ${method} ${url}`);
}

async function main() {
  process.env = { ...originalEnv };
  // Deterministic, offline: no Supabase (in-memory registry), no Google key
  setEnvUndefined('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
    'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY',
    'UPSTASH_VECTOR_REST_URL', 'UPSTASH_VECTOR_REST_TOKEN');
  process.env.EMBEDDING_DIMS = '64';   // tiny vectors for a fast, exact test
  process.env.UPSTASH_VECTOR_REST_URL = 'https://uvt.example.com'; // routes through the stub
  process.env.UPSTASH_VECTOR_REST_TOKEN = 'test-token';
  globalThis.fetch = stubbedFetch as typeof fetch;

  // ── 1) Chunker: sizes, overlap, no empty chunks ────────────────────────────
  const longText = Array.from({ length: 60 }, (_, i) =>
    `Paragraph ${i}. The quick brown fox jumps over the lazy dog. Revenue grew steadily in quarter ${i % 4 + 1} of the year, driven by subscriptions and enterprise contracts.`
  ).join('\n\n');
  const chunks = chunkText(longText);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length >= 20, 'chunk too small');
    assert.ok(c.length <= 1200, `chunk too big: ${c.length}`);
  }
  // Overlap: consecutive chunks share content
  assert.ok(chunks[1].includes('…'), 'second chunk should carry overlap context');
  assert.deepEqual(chunkText(''), []);

  // ── 2) Ingest a plain-text document end-to-end ─────────────────────────────
  const userId = 'user-test-123';
  const docText = [
    'SOHAM Product Handbook.',
    'The quarterly subscription revenue for Acme Corp reached INR 42 lakh in October 2026.',
    'Customer churn dropped to 2.1 percent after the onboarding revamp.',
    'The recommended deployment target is Render, with Supabase for persistence.',
  ].join('\n\n');
  const doc = await ingestDocument(userId, {
    buffer: Buffer.from(docText, 'utf8'),
    name: 'acme-handbook.md',
    mimeType: 'text/markdown',
    sizeBytes: Buffer.byteLength(docText),
  });
  assert.equal(doc.status, 'ready');
  assert.ok(doc.chunkCount >= 1);
  assert.ok(store.size >= doc.chunkCount, 'chunks must be in the vector store');

  // ── 3) Retrieval: finds the right doc, respects user isolation ──────────────
  const hits = await searchDocuments(userId, 'quarterly subscription revenue Acme', 4, 0.05);
  assert.ok(hits.length >= 1, 'expected to retrieve the handbook chunk');
  assert.equal(hits[0].docName, 'acme-handbook.md');
  assert.ok(hits[0].text.includes('subscription revenue'));

  const foreign = await searchDocuments('user-other-999', 'quarterly subscription revenue Acme', 4, 0.0);
  assert.equal(foreign.length, 0, 'documents must never leak across users');

  // ── 4) Registry list + delete ───────────────────────────────────────────────
  const docs = await listDocuments(userId);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, 'acme-handbook.md');

  const ok = await deleteDocument(userId, doc.id);
  assert.equal(ok, true);
  assert.equal(store.size, 0, 'delete must remove the vectors');
  assert.equal((await listDocuments(userId)).length, 0);

  // ── 4b) PDF ingestion (pdf-parse) with a real minimal PDF ───────────────
  const minimalPdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 70 >> stream
BT /F1 12 Tf 72 720 Td (Acme quarterly revenue INR 42 lakh 2026) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`, 'binary');
  const pdfDoc = await ingestDocument(userId, {
    buffer: minimalPdf,
    name: 'acme-q3.pdf',
    mimeType: 'application/pdf',
    sizeBytes: minimalPdf.length,
  });
  assert.equal(pdfDoc.status, 'ready', `PDF ingest failed: ${pdfDoc.error}`);
  assert.ok(pdfDoc.chunkCount >= 1);
  const pdfHit = await searchDocuments(userId, 'Acme quarterly revenue', 3, 0.05);
  assert.ok(pdfHit.some(h => h.docName === 'acme-q3.pdf'), 'PDF chunk must be retrievable');

  // Restore isolation expectation: delete everything created so far
  for (const d of await listDocuments(userId)) await deleteDocument(userId, d.id);
  assert.equal(store.size, 0);

  // ── 5) Failure path: unreadable file → status failed, no vectors ────────────
  const failed = await ingestDocument(userId, {
    buffer: Buffer.from([0x00, 0x01, 0x02]),   // 3 bytes of nothing readable
    name: 'empty.txt',
    mimeType: 'text/plain',
    sizeBytes: 3,
  });
  assert.equal(failed.status, 'failed');

  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  console.log('rag checks passed ✔');
}

function setEnvUndefined(...keys: string[]) {
  for (const k of keys) delete process.env[k];
}

main().catch(err => {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
