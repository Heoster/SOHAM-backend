/**
 * Document RAG — upload, chunk, embed, retrieve YOUR documents.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pipeline (per uploaded file, ≤ 10 MB):
 *   1. Extract text   PDF (pdf-parse) / DOCX (mammoth) / TXT·MD·CSV·JSON·plain
 *   2. Chunk          paragraph/sentence-aware, ~900 chars, 150 overlap
 *   3. Embed          shared dimension-pinned embeddings (memory/embeddings.ts)
 *   4. Store          Pinecone Vector — namespace "docs", user_id metadata filter
 *                     (ids: doc:{userId}:{docId}:{chunkIndex})
 *   5. Registry       Supabase `documents` table (REST) with in-memory fallback
 *
 * Retrieval: `searchDocuments` embeds the query and queries Pinecone with a
 * `namespace = 'docs' AND user_id = '…'` filter (client-side filter fallback),
 * and the orchestrator injects the best chunks as a "Your documents" layer.
 *
 * Set-up: run the SQL in memory/SUPABASE_SETUP.sql (documents table) and
 * create ONE Pinecone Vector index — embedding dimensions are auto-detected.
 */

import { randomUUID } from 'crypto';
import { generateEmbedding } from './embeddings';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocumentStatus = 'processing' | 'ready' | 'failed';

export interface DocumentRecord {
  id: string;
  userId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  status: DocumentStatus;
  error?: string;
  truncated?: boolean;
  createdAt: string;
}

export interface DocumentSearchHit {
  docId: string;
  docName: string;
  chunkIndex: number;
  text: string;
  similarity: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;       // 10 MB hard cap (enforced again at the route)
const MAX_TEXT_CHARS = 1_500_000;              // ~400 dense pages of text
const MAX_CHUNKS = 400;                        // per document
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;

// ─── Chunking (paragraph → sentence aware) ────────────────────────────────────

export function chunkText(text: string, maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!normalized) return [];

  // Split into sentences but keep paragraph breaks as hard boundaries
  const pieces: string[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const para = paragraph.trim();
    if (!para) continue;
    if (para.length <= maxChars) { pieces.push(para); continue; }
    // Long paragraph → sentence windows
    const sentences = para.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g) ?? [para];
    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > maxChars && current) {
        pieces.push(current.trim());
        current = current.slice(-overlap) + sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }

  // Merge tiny fragments forward so every chunk carries its weight
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged.length - 1;
    if (last >= 0 && merged[last].length + piece.length + 1 <= maxChars * 0.6) {
      merged[last] = `${merged[last]}\n${piece}`;
    } else {
      merged.push(piece);
    }
  }

  // Carry overlap context into the next chunk for continuity
  const chunks: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    if (i > 0 && overlap > 0) {
      const tail = merged[i - 1].slice(-overlap).replace(/^\S+\s/, ''); // start on a word boundary
      chunks.push(`…${tail}\n${merged[i]}`);
    } else {
      chunks.push(merged[i]);
    }
  }
  return chunks.map(c => c.trim()).filter(c => c.length >= 20);
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function extractText(buffer: Buffer, mimeType: string, name: string): Promise<string> {
  const lower = name.toLowerCase();
  const isPdf = mimeType === 'application/pdf' || lower.endsWith('.pdf');
  const isDocx = mimeType.includes('officedocument.wordprocessingml') || lower.endsWith('.docx');

  if (isPdf) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return String(result?.text ?? '').trim();
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (isDocx) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return String(result?.value ?? '').trim();
  }
  // Plain-text family: txt, md, csv, json, xml, log, yaml, html(ish)
  const text = buffer.toString('utf8');
  // Strip HTML tags when the file is clearly HTML
  if (mimeType.includes('html') || lower.endsWith('.html') || lower.endsWith('.htm')) {
    return text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return text.trim();
}

// ─── Pinecone helpers ──────────────────────────────────────────────────────────

import { isPineconeReady, vectorRequest as vectorFetch } from './pinecone-vector';

// ─── Document registry (Supabase documents table, in-memory fallback) ─────────

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  return { url, key, ready: Boolean(url && key) };
}

async function sbFetch(path: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const { url, key } = getSupabase();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(tid);
  }
}

// In-memory fallback for environments without Supabase (single process only)
const localRegistry = new Map<string, DocumentRecord & { chunkIds: string[] }>();

function rowToRecord(row: any): DocumentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id ?? row.userId ?? ''),
    name: String(row.name ?? 'document'),
    mimeType: String(row.mime_type ?? row.mimeType ?? 'application/octet-stream'),
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes ?? 0),
    chunkCount: Number(row.chunk_count ?? row.chunkCount ?? 0),
    status: (row.status as DocumentStatus) ?? 'ready',
    error: row.error ?? undefined,
    truncated: Boolean(row.truncated),
    createdAt: String(row.created_at ?? row.createdAt ?? new Date().toISOString()),
  };
}

function stripChunkIds(doc: DocumentRecord & { chunkIds?: string[] }): DocumentRecord {
  const { chunkIds: _chunkIds, ...record } = doc;
  return record;
}

export async function listDocuments(userId: string): Promise<DocumentRecord[]> {
  const { ready } = getSupabase();
  if (!ready) {
    return [...localRegistry.values()]
      .filter(d => d.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(stripChunkIds);
  }
  const res = await sbFetch(`documents?user_id=eq.${encodeURIComponent(userId)}&select=*&order=created_at.desc&limit=50`);
  if (!res.ok) throw new Error(`documents list failed: ${res.status}`);
  const rows = await res.json() as any[];
  return rows.map(rowToRecord);
}

export async function getDocument(userId: string, docId: string): Promise<DocumentRecord | null> {
  const { ready } = getSupabase();
  if (!ready) {
    const doc = localRegistry.get(docId);
    return doc && doc.userId === userId ? stripChunkIds(doc) : null;
  }
  const res = await sbFetch(`documents?id=eq.${encodeURIComponent(docId)}&user_id=eq.${encodeURIComponent(userId)}&select=*`);
  if (!res.ok) throw new Error(`document fetch failed: ${res.status}`);
  const rows = await res.json() as any[];
  return rows.length ? rowToRecord(rows[0]) : null;
}

async function registryInsert(record: DocumentRecord & { chunkIds: string[] }): Promise<void> {
  const { ready } = getSupabase();
  const row = {
    id: record.id,
    user_id: record.userId,
    name: record.name,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    chunk_count: record.chunkCount,
    status: record.status,
    error: record.error ?? null,
    truncated: Boolean(record.truncated),
    chunk_ids: record.chunkIds,
    created_at: record.createdAt,
  };
  if (!ready) { localRegistry.set(record.id, record); return; }
  const res = await sbFetch('documents', { method: 'POST', body: JSON.stringify(row) });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    logger.warn('[Docs] Registry insert failed — keeping vectors only', { error: err.slice(0, 200) });
  }
}

interface RegistryPatch {
  status?: DocumentStatus;
  error?: string | null;
  chunk_count?: number;
  truncated?: boolean;
  chunk_ids?: string[];
}

async function registryUpdate(id: string, patch: RegistryPatch): Promise<void> {
  const { ready } = getSupabase();
  if (!ready) {
    const existing = localRegistry.get(id);
    if (existing) {
      if (patch.status !== undefined) existing.status = patch.status;
      if (patch.error !== undefined) existing.error = patch.error ?? undefined;
      if (patch.chunk_count !== undefined) existing.chunkCount = patch.chunk_count;
      if (patch.truncated !== undefined) existing.truncated = patch.truncated;
      if (patch.chunk_ids !== undefined) existing.chunkIds = patch.chunk_ids;
    }
    return;
  }
  const res = await sbFetch(`documents?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!res.ok) logger.warn('[Docs] Registry update failed', { id, status: res.status });
}

async function registryDelete(id: string): Promise<string[]> {
  const { ready } = getSupabase();
  if (!ready) {
    const chunkIds = localRegistry.get(id)?.chunkIds ?? [];
    localRegistry.delete(id);
    return chunkIds;
  }
  const res = await sbFetch(`documents?id=eq.${encodeURIComponent(id)}&select=chunk_ids`, { method: 'GET' });
  let chunkIds: string[] = [];
  if (res.ok) {
    const rows = await res.json() as any[];
    chunkIds = Array.isArray(rows?.[0]?.chunk_ids) ? rows[0].chunk_ids : [];
  }
  await sbFetch(`documents?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  return chunkIds;
}

// ─── Vector upsert/query ──────────────────────────────────────────────────────

async function upsertChunk(userId: string, docId: string, docName: string, chunkIndex: number, text: string): Promise<string | null> {
  if (!isPineconeReady()) return null;
  const id = `doc:${userId}:${docId}:${chunkIndex}`;

  const vector = await generateEmbedding(text);
  await vectorFetch('/upsert', {
    vectors: [{
      id,
      vector,
      metadata: {
        type: 'DOCUMENT_CHUNK',
        namespace: 'docs',
        user_id: userId,
        doc_id: docId,
        doc_name: docName.slice(0, 200),
        chunk_index: chunkIndex,
        created_at: new Date().toISOString(),
        content_preview: text.slice(0, 400),
      },
      data: text.slice(0, 4000),
    }],
  });
  return id;
}

export async function searchDocuments(userId: string | undefined, query: string, topK = 4, minSimilarity = 0.30): Promise<DocumentSearchHit[]> {
  if (!userId || !isPineconeReady()) return [];
  const safeUser = userId;

  const semantic = { vector: await generateEmbedding(query.slice(0, 1500)) };

  let payload: any;
  try {
    payload = await vectorFetch('/query', {
      ...semantic,
      topK,
      includeMetadata: true,
      includeData: true,
      filter: { $and: [{ namespace: { $eq: 'docs' } }, { user_id: { $eq: safeUser } }] },
    });
  } catch {
    return []; // Fail closed; never retry without the metadata scope.
  }

  const matches: any[] = payload?.result ?? payload?.matches ?? [];
  return matches
    .filter((m: any) => {
      const md = m?.metadata ?? {};
      const id = String(m?.id ?? '');
      const ns = md.namespace as string | undefined;
      const uid = (md.user_id as string | undefined) ?? '';
      return (ns === 'docs' || id.startsWith('doc:')) && (uid ? uid === userId : id.split(':')[1] === userId);
    })
    .map((m: any) => ({
      docId: String(m?.metadata?.doc_id ?? String(m.id).split(':')[2] ?? ''),
      docName: String(m?.metadata?.doc_name ?? 'document'),
      chunkIndex: Number(m?.metadata?.chunk_index ?? 0),
      text: typeof m?.data === 'string' && m.data ? m.data
        : typeof m?.metadata?.content_preview === 'string' ? m.metadata.content_preview
        : '',
      similarity: Number(m?.score ?? 0),
    }))
    .filter(hit => hit.similarity >= minSimilarity && hit.text.length > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

export interface IngestInput {
  buffer: Buffer;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export async function ingestDocument(userId: string, input: IngestInput): Promise<DocumentRecord> {
  if (input.sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`File is ${(input.sizeBytes / 1024 / 1024).toFixed(1)}MB — the limit is 10MB`);
  }

  const docId = randomUUID();
  const now = new Date().toISOString();
  const record: DocumentRecord & { chunkIds: string[] } = {
    id: docId,
    userId,
    name: input.name.slice(0, 240) || 'document',
    mimeType: input.mimeType || 'application/octet-stream',
    sizeBytes: input.sizeBytes,
    chunkCount: 0,
    status: 'processing',
    createdAt: now,
    chunkIds: [],
  };
  await registryInsert({ ...record, status: 'processing' });

  try {
    let text = await extractText(input.buffer, input.mimeType, input.name);
    if (!text || text.length < 20) {
      throw new Error('Could not extract readable text from this file (scanned image PDFs are not supported yet)');
    }
    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; }

    let chunks = chunkText(text);
    if (chunks.length > MAX_CHUNKS) { chunks = chunks.slice(0, MAX_CHUNKS); truncated = true; }
    if (chunks.length === 0) throw new Error('No usable text chunks produced');

    // Embed + upsert with bounded concurrency
    const CONCURRENCY = 8;
    const chunkIds: string[] = [];
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((chunk, j) => upsertChunk(userId, docId, record.name, i + j, chunk)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) chunkIds.push(r.value);
        else if (r.status === 'rejected') logger.warn('[Docs] Chunk upsert failed', { error: String(r.reason).slice(0, 160) });
      }
    }
    if (chunkIds.length === 0) {
      throw new Error('Embedding store failed for every chunk — is Pinecone Vector configured?');
    }

    record.status = 'ready';
    record.chunkCount = chunkIds.length;
    record.truncated = truncated;
    record.chunkIds = chunkIds;
    await registryUpdate(docId, { status: 'ready', chunk_count: chunkIds.length, truncated, chunk_ids: chunkIds });
    logger.info('[Docs] Ingested document', { docId, userId, chunks: chunkIds.length, truncated });
    return { ...record, chunkCount: chunkIds.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record.status = 'failed';
    record.error = message.slice(0, 300);
    await registryUpdate(docId, { status: 'failed', error: record.error, chunk_count: 0 });
    logger.warn('[Docs] Ingest failed', { docId, userId, error: message.slice(0, 200) });
    return { ...record, error: record.error };
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteDocument(userId: string, docId: string): Promise<boolean> {
  const existing = await getDocument(userId, docId);
  if (!existing) return false;
  const chunkIds = await registryDelete(docId);

  if (chunkIds.length > 0 && isPineconeReady()) {
    try {
      await vectorFetch('/delete', { ids: chunkIds.slice(0, 1000) });
    } catch (err) {
      logger.warn('[Docs] Vector delete failed (registry row removed anyway)', { error: String(err).slice(0, 160) });
    }
  } else if (chunkIds.length === 0) {
    // No chunk ids recorded — best-effort delete by deterministic id pattern
    logger.info('[Docs] No chunk ids stored for document; vectors may linger until overwritten', { docId });
  }
  return true;
}
