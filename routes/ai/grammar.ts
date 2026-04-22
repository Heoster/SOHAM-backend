/**
 * POST /api/ai/grammar
 * Grammar correction and writing improvement.
 * Body: { text: string, mode?, targetAudience?, preferredModel? }
 * Response: { correctedText, changes, overallScore, readabilityScore, summary, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedGrammar } from '../../flows/enhanced-grammar';

export async function grammarHandler(req: Request, res: Response): Promise<void> {
  try {
    const { text, mode, targetAudience, preferredModel } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'MISSING_TEXT', message: 'text is required and must be a string' });
      return;
    }
    const result = await enhancedGrammar({ text, mode, targetAudience, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'GRAMMAR_FAILED', message: error instanceof Error ? error.message : 'Grammar check failed' });
  }
}
