# Pinecone vector storage

SOHAM now uses Pinecone for private chat memory, document chunks, public knowledge,
and cached live results. Supabase history/registries and Upstash **Redis** rate
limiting remain unchanged. Old `UPSTASH_VECTOR_*` variables are ignored.

## Deployment

1. In Pinecone, create or select a **dense, cosine** index. This implementation
   supplies its own embeddings; do not select an integrated-embedding-only index.
   Recommended: 768 dimensions with Google's `gemini-embedding-001`.
2. Set server-side secrets in Render (never frontend code or Git):
   - `PINECONE_API_KEY`: key with read/write access to the index.
   - `PINECONE_INDEX_HOST`: index data-plane host from Pinecone, not the console URL
     or index name (e.g. `https://your-index-xxxx.svc.region.pinecone.io`).
   - `PINECONE_NAMESPACE=soham`: optional deployment namespace; use a separate value
     for staging. All record types share this namespace with metadata scopes.
   - `GOOGLE_API_KEY`: enables semantic embeddings (existing Google aliases work).
   - `EMBEDDING_DIMS=768`: optional override; must match the index. Otherwise the
     dimension is read from Pinecone `/describe_index_stats` and cached.
3. Remove obsolete `UPSTASH_VECTOR_*` secrets and redeploy.
4. Run the read-only check in an environment with these secrets:
   `node -r ts-node/register/transpile-only scripts/setup-pinecone-check.ts`.
   The health endpoint reports `memory.pinecone`.

No database is provisioned or deleted by this code. Without Pinecone credentials,
vector features stay disabled; there is no fallback to Upstash Vector.

## Existing data and embedding compatibility

This is a backend switch, **not a data migration**. Existing Upstash vectors remain
untouched and will not appear in Pinecone. Re-ingest documents and rebuild vector
memories from source data as needed. Do not copy vectors produced by a different
embedding model/dimension into the same namespace.

The existing deterministic hash fallback remains available when Google embeddings
are unavailable. It is not semantic search and is not compatible with Google's
embedding space. For production, keep the Google key available and rebuild any
records written with hash embeddings before relying on semantic retrieval.

Pinecone writes are eventually consistent; a newly written record may not be
immediately searchable. Metadata scopes isolate users and record types; failed
scoped queries are not retried without a scope.

## Offline tests

`npm run test:pinecone` checks Pinecone headers/payloads, text preservation,
fetch/update/delete, dimension detection, chat-memory isolation, and document
text/PDF ingestion/search/delete. All requests are mocked; no live service is used.
