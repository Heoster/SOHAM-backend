/** Quarantined during cross-user disclosure containment; no public conversation reads/writes. */
import type { Request, Response } from 'express';

async function quarantined(_req: Request, res: Response): Promise<void> {
  res.status(403).json({ error: 'SHARED_KNOWLEDGE_QUARANTINED' });
}
export const storeKnowledgeHandler = quarantined;
export const searchKnowledgeHandler = quarantined;
export const storeCorrectionHandler = quarantined;
export const storeSuggestionHandler = quarantined;
