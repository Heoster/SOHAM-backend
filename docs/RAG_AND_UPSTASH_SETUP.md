# SOHAM RAG & Upstash Setup Guide

## 1. Does SOHAM have RAG? — Inventory

**Yes — now it does, fully.** What existed vs. what was added:

| Layer | Store | Purpose | Status |
|---|---|---|---|
| L3 Long-term memory | Supabase `memories` (JSONB + client-side cosine) | facts about the user across sessions | existing |
| L5 Semantic RAG | Upstash Vector (private ids) | conversation recall across devices | existing |
| L6 Public knowledge | Upstash Vector (`public:` namespace) | corrections/suggestions, shared across users | existing |
| L1 Live data | Upstash Vector (TTL chunks) | realtime chunks cached from tools | existing |
| **L7 Uploaded documents** | **Upstash Vector (`docs` namespace)** | **RAG over files YOU upload (≤10MB)** | **new** |
| Web page reading | — | top search results are **read in full** (Jina primary, Firecrawl fallback) and given to the model | **new** |

Before this change, "RAG" in SOHAM meant *memory* only — there was no document
ingestion, and the chat web-search answered from snippets.

## 2. Create the Upstash Vector index (≈ 3 minutes)

1. Go to https://console.upstash.com → **Vector** → **Create Index**.
2. Settings:
   - **Name**: `soham` (anything)
   - **Type**: `Dense`
   - **Dimensions**: any fixed value — it must match your embeddings. SOHAM now
     **auto-detects** it via `/info`, so you don't need to configure anything:
     - If you create it fresh, **1536** is a good default (fast, accurate with
       gemini-embedding-001's Matryoshka truncation). 3072 = max quality, 768 = fastest.
     - You may keep an existing index at any dimension (512/768/1024/1536…) —
       SOHAM reads the real value and sizes every vector to it.
   - **Similarity function**: `COSINE`
3. Open the index → **Details** → copy:
   - **REST URL** → `UPSTASH_VECTOR_REST_URL`
   - **REST Token** → `UPSTASH_VECTOR_REST_TOKEN`
4. (Optional) If `/info` can't be reached from your host, set the same dimension:
   `EMBEDDING_DIMS=1536`

## 3. Configure the server (Render / env)

```bash
UPSTASH_VECTOR_REST_URL=https://<id>.upstash.io
UPSTASH_VECTOR_REST_TOKEN=<token>
# EMBEDDING_DIMS=1536        # only if the /info probe can't be used
SUPABASE_URL=...             # already used by memories/profile
SUPABASE_SERVICE_ROLE_KEY=...
JINA_API_KEY=...             # page reading (primary) + web search
FIRECRAWL_API_KEY=...        # page reading (fallback) — optional
```

## 4. Verify — one command

```bash
node -r ts-node/register/transpile-only scripts/setup-upstash-check.ts
```

It prints the index dimension, then round-trips a throwaway vector
(upsert → query → delete). Safe to run repeatedly. It exits non-zero with an
exact fix message if anything is wrong.

Watch the boot logs for:
`[Embedding] Upstash index dimension is 1536 (via /info)`

## 5. Create the `documents` registry table in Supabase

Run the SQL at the bottom of `memory/SUPABASE_SETUP.sql` in the Supabase SQL
editor (adds the `documents` table). The chunk **vectors** live in Upstash;
this table only tracks your files (name, status, chunk ids for deletion).
Without it, the server falls back to an in-memory registry (works, but the
document list resets on restart).

## 6. Upload & query documents (API)

```bash
# Upload (≤10MB): pdf, docx, txt, md, csv, json, xml, html, log, yaml
curl -X POST https://<host>/api/documents/upload \
  -H "Authorization: Bearer $SOHAM_API_KEY" \
  -F "file=@report.pdf" -F "userId=user-123"

# List / inspect / delete
curl "https://<host>/api/documents?userId=user-123"          -H "Authorization: Bearer $SOHAM_API_KEY"
curl "https://<host>/api/documents/<id>?userId=user-123"     -H "Authorization: Bearer $SOHAM_API_KEY"
curl -X DELETE "https://<host>/api/documents/<id>?userId=user-123" -H "Authorization: Bearer $SOHAM_API_KEY"
```

Then simply chat: *"summarise the report I uploaded"* — the relevant chunks are
auto-retrieved and injected as the **Uploaded documents** layer.

Supported files: PDF, DOCX, TXT, MD, CSV, JSON, XML, HTML, logs, YAML.
Limits: 10 MB per file · 400 chunks per document · 400-char metadata preview
per chunk (full chunk text stored alongside as the vector's `data`).

## 7. Website reading after search (Jina → Firecrawl)

- Chat web search (`web_search` tool) now runs
  `Tavily/Wikipedia/DuckDuckGo → merge → read top 3 URLs` and injects the
  actual page text (≤1500 chars each) into the prompt, with citations `[n]`.
- **Jina Reader is primary** (`r.jina.ai`, works without a key but is
  rate-limited — set `JINA_API_KEY`), **Firecrawl is the fallback**.
- 12-second total budget; if reading fails, SOHAM answers from snippets
  exactly as before. `fullContent` always remains optional.

## 8. Troubleshooting (seen in production)

| Symptom | Cause | Fix |
|---|---|---|
| `Upstash /upsert 400 … column: 39745` / "Missing or wrong input" | Google default 3072-dim vectors vs. an index created with another dimension | Fixed in `memory/embeddings.ts` — dimension is auto-detected (or `EMBEDDING_DIMS=<n>`). Re-run `scripts/setup-upstash-check.ts` |
| `[Knowledge] Store failed` spam | same as above | same fix |
| Search works but nothing is found in knowledge | `/query` 400-ed the same way, silently caught | same fix; verify via `POST /api/memory/knowledge/search` |
| Document upload → `INGEST_FAILED` | Upstash not configured, or file is a scanned PDF (no text layer) | configure `UPSTASH_VECTOR_REST_*`; scanned PDFs need OCR (not supported) |
| Document list empty after restart | Supabase `documents` table missing | run the SQL in §5 |

## 9. Notes & limits

- **Every Upstash write sizes the vector to the index** — embeddings from Google
  (`outputDimensionality`), the hash fallback and the offline test path all
  agree on the dimension. You cannot mix dimensions in one index.
- Existing Supabase memory rows with different-dim embeddings compare as ~0
  similarity until re-stored (zero-padded — no crashes).
- Document deletion removes the vectors by id (`chunk_ids` recorded in the
  registry) and the registry row. Governance/TTL for documents is manual.
