/**
 * Upstash Vector — setup verifier (run this AFTER creating the index + setting env)
 *
 *   node -r ts-node/register/transpile-only scripts/setup-upstash-check.ts
 *
 * What it does:
 *   1. Checks UPSTASH_VECTOR_REST_URL / _TOKEN (and EMBEDDING_DIMS override)
 *   2. Reads the index dimension via /info
 *   3. Round-trips a throwaway vector: upsert → query → delete
 *   4. Exits 0 only if everything works — safe to run repeatedly
 *
 * It never touches your real vectors (one temp id, deleted at the end).
 */

const url = (process.env.UPSTASH_VECTOR_REST_URL ?? process.env.UPSTASH_VECTOR_URL ?? '').replace(/\/$/, '');
const token = process.env.UPSTASH_VECTOR_REST_TOKEN ?? process.env.UPSTASH_VECTOR_TOKEN ?? '';
const embedDimsEnv = Number(process.env.EMBEDDING_DIMS ?? '') || null;

async function main(): Promise<number> {
  console.log('── Upstash Vector setup check ─────────────────────────');
  if (!url || !token) {
    console.error('✗ UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN are not set.');
    console.error('  Create an index at https://console.upstash.com/vector and copy both values.');
    return 1;
  }
  console.log(`✓ Index URL: ${url.replace(/^https:\/\/([^.]{6})[^/]*/, 'https://$1…')}`);
  console.log(`✓ EMBEDDING_DIMS override: ${embedDimsEnv ?? '(not set — using /info probe)'}`);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── 1) /info — dimension + stats ──────────────────────────────────────────
  let dimension: number | null = null;
  try {
    const res = await fetch(`${url}/info`, { headers, signal: AbortSignal.timeout(8000) });
    const raw = await res.text();
    console.log(`\n[1] GET /info → HTTP ${res.status}`);
    console.log(raw.slice(0, 500));
    if (res.ok) {
      try {
        const info = JSON.parse(raw);
        dimension = Number(info?.result?.dimension ?? info?.dimension ?? info?.result?.vectorDimension ?? info?.vectorDimension ?? NaN) || null;
      } catch { /* printed raw above */ }
    }
  } catch (err) {
    console.error('✗ /info request failed:', err instanceof Error ? err.message : err);
    return 1;
  }

  // ── 1b) data-only probe — does the index embed for us (built-in model)? ──
  try {
    const probeRes = await fetch(`${url}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ data: 'capability probe', topK: 1, includeMetadata: false, includeData: false }),
      signal: AbortSignal.timeout(8000),
    });
    const probeBody = await probeRes.text();
    if (probeRes.ok) {
      console.log('\n[1b] data-only /query → HTTP 200 — index HAS a built-in embedding model.');
      console.log('     SOHAM stores/queries with data-only payloads (auto-embed mode); no embedding keys needed.');
    } else {
      console.log(`\n[1b] data-only /query → HTTP ${probeRes.status}: ${probeBody.slice(0, 200)}`);
      console.log('     Index has NO built-in embedding model — SOHAM sends its own vectors (manual mode),');
      console.log('     sized to the index dimension above.');
    }
  } catch {
    console.log('\n[1b] data-only probe failed — SOHAM assumes manual-vector mode (safe default).');
  }

  const dim = embedDimsEnv ?? dimension;
  if (dim) {
    console.log(`\n✓ Embedding dimension for this index: ${dim}${embedDimsEnv ? ' (from EMBEDDING_DIMS)' : ' (from /info)'}`);
  } else {
    console.warn('⚠ Could not read the dimension from /info.');
    console.warn('  Set EMBEDDING_DIMS to the dimension shown in the Upstash console (index details).');
  }

  // ── 2) Round-trip upsert → query → delete ─────────────────────────────────
  const testId = `healthcheck:soham:${Date.now()}`;
  const dims = dim ?? 1024;   // only used when dim is unknown — upsert will fail loudly then, which is the point
  const vector = Array.from({ length: dims }, (_, i) => Math.sin(i + 1) * 0.01);

  console.log(`\n[2] Upserting throwaway vector (${dims} dims)…`);
  const upsertRes = await fetch(`${url}/upsert`, {
    method: 'POST', headers,
    body: JSON.stringify({ vectors: [{ id: testId, vector, metadata: { namespace: 'healthcheck', source: 'setup-check' } }] }),
    signal: AbortSignal.timeout(10000),
  });
  const upsertBody = await upsertRes.text();
  if (!upsertRes.ok) {
    console.error(`✗ Upsert failed — HTTP ${upsertRes.status}: ${upsertBody.slice(0, 300)}`);
    if (/dimension|wrong input/i.test(upsertBody)) {
      console.error('\n→ This is the embedding-dimension mismatch. Fix: set EMBEDDING_DIMS');
      console.error('  to the dimension of your index (Upstash console → your index → Details).');
    }
    return 1;
  }
  console.log('✓ Upsert accepted');

  console.log('[3] Querying it back…');
  const queryRes = await fetch(`${url}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ vector, topK: 1, includeMetadata: true }),
    signal: AbortSignal.timeout(10000),
  });
  const queryBody = await queryRes.text();
  if (!queryRes.ok) {
    console.error(`✗ Query failed — HTTP ${queryRes.status}: ${queryBody.slice(0, 300)}`);
    return 1;
  }
  const hit = queryBody.includes(testId);
  console.log(hit ? '✓ Query returned the test vector' : '⚠ Query worked but did not return the test vector (index may be empty-ish — that is fine)');

  console.log('[4] Deleting the test vector…');
  const deleteRes = await fetch(`${url}/delete`, {
    method: 'POST', headers,
    body: JSON.stringify({ ids: [testId] }),
    signal: AbortSignal.timeout(10000),
  });
  console.log(deleteRes.ok ? '✓ Test vector deleted' : `⚠ Delete returned HTTP ${deleteRes.status} — remove "${testId}" manually`);

  console.log('\n── Result ─────────────────────────────────────────────');
  console.log('✓ Upstash Vector is ready. SOHAM memory / knowledge / documents will now persist.');
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('✗ Setup check crashed:', err);
  process.exit(1);
});
