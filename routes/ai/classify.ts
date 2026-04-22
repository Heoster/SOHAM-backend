/**
 * POST /api/ai/classify
 * Text classification into categories.
 * Body: { text: string, categories?: string[], multiLabel?, preferredModel? }
 * Response: { primaryCategory, allCategories, isMultiLabel, summary, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedClassify } from '../../flows/enhanced-classify';

export async function classifyHandler(req: Request, res: Response): Promise<void> {
  try {
    const { text, categories, multiLabel, preferredModel } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'MISSING_TEXT', message: 'text is required and must be a string' });
      return;
    }
    const result = await enhancedClassify({ text, categories, multiLabel, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'CLASSIFY_FAILED', message: error instanceof Error ? error.message : 'Classification failed' });
  }
}
