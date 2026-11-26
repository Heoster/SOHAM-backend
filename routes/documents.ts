import { requireOwnedUser } from '../middleware/user-identity';
/**
 * Documents — upload & manage user documents for RAG.
 *
 * POST   /api/documents/upload    multipart form: file (≤10MB) + userId  → ingest
 * GET    /api/documents?userId=   list a user's documents
 * GET    /api/documents/:id?userId=   single document metadata
 * DELETE /api/documents/:id?userId=   delete document + its vectors
 */

import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ingestDocument, listDocuments, getDocument, deleteDocument } from '../memory/document-rag';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10 MB
});

const ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.log', '.yaml', '.yml', '.docx', '.html', '.htm', '.rtf'];

/** Wrap multer so oversized files return a clean 413 instead of a 500. */
export function uploadSingle(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      const tooBig = err?.code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
        message: tooBig ? 'File exceeds the 10MB limit.' : (err?.message ?? 'Upload failed'),
      });
      return;
    }
    next();
  });
}

// ── POST /api/documents/upload ────────────────────────────────────────────────

export async function uploadDocumentHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireOwnedUser(req, res);
    if (!userId) return;
    if (!userId) {
      res.status(400).json({ error: 'MISSING_USER', message: 'userId is required (form field or query param)' });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'MISSING_FILE', message: 'Attach a file in the "file" form field' });
      return;
    }
    const name = String(req.body?.name || file.originalname || 'document');
    const lower = name.toLowerCase();
    const hasAllowedExt = ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
    const mime = file.mimetype || 'application/octet-stream';
    const isTextLike = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';
    if (!hasAllowedExt && !isTextLike && mime !== 'application/pdf' && !mime.includes('officedocument')) {
      res.status(415).json({
        error: 'UNSUPPORTED_TYPE',
        message: `Unsupported file type "${mime}". Supported: PDF, DOCX, TXT, MD, CSV, JSON, XML, HTML, logs.`,
      });
      return;
    }

    const document = await ingestDocument(userId, {
      buffer: file.buffer,
      name,
      mimeType: mime,
      sizeBytes: file.size,
    });

    if (document.status === 'failed') {
      res.status(422).json({ error: 'INGEST_FAILED', message: document.error ?? 'Could not process this document', document });
      return;
    }
    res.status(201).json({ document });
  } catch (err) {
    console.error('[Docs] Upload failed:', err);
    res.status(500).json({ error: 'UPLOAD_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
}

// ── GET /api/documents?userId= ────────────────────────────────────────────────

export async function listDocumentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireOwnedUser(req, res);
    if (!userId) return;
    if (!userId) { res.status(400).json({ error: 'MISSING_USER', message: 'userId query param is required' }); return; }
    const documents = await listDocuments(userId);
    res.json({ documents, count: documents.length });
  } catch (err) {
    res.status(500).json({ error: 'LIST_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
}

// ── GET /api/documents/:id?userId= ────────────────────────────────────────────

export async function getDocumentHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireOwnedUser(req, res);
    if (!userId) return;
    const id = String(req.params?.id ?? '').trim();
    if (!userId || !id) { res.status(400).json({ error: 'MISSING_PARAMS', message: 'userId and document id are required' }); return; }
    const document = await getDocument(userId, id);
    if (!document) { res.status(404).json({ error: 'NOT_FOUND', message: 'Document not found' }); return; }
    res.json({ document });
  } catch (err) {
    res.status(500).json({ error: 'GET_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
}

// ── DELETE /api/documents/:id?userId= ─────────────────────────────────────────

export async function deleteDocumentHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireOwnedUser(req, res);
    if (!userId) return;
    const id = String(req.params?.id ?? '').trim();
    if (!userId || !id) { res.status(400).json({ error: 'MISSING_PARAMS', message: 'userId and document id are required' }); return; }
    const ok = await deleteDocument(userId, id);
    if (!ok) { res.status(404).json({ error: 'NOT_FOUND', message: 'Document not found' }); return; }
    res.json({ deleted: true, id });
  } catch (err) {
    res.status(500).json({ error: 'DELETE_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
}
