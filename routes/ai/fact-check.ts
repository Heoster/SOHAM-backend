/**
 * POST /api/ai/fact-check
 * Fact-checking with web search and AI reasoning.
 * Body: { claim: string, preferredModel? }
 * Response: { claim, verdict, confidence, explanation, evidence, sources, nuance, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedFactCheck } from '../../flows/enhanced-fact-check';

export async function factCheckHandler(req: Request, res: Response): Promise<void> {
  try {
    const { claim, preferredModel } = req.body;
    if (!claim || typeof claim !== 'string') {
      res.status(400).json({ error: 'MISSING_CLAIM', message: 'claim is required and must be a string' });
      return;
    }
    const result = await enhancedFactCheck({ claim, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'FACT_CHECK_FAILED', message: error instanceof Error ? error.message : 'Fact check failed' });
  }
}
