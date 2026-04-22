/**
 * POST /api/ai/sentiment
 * Sentiment analysis with emotion detection.
 * Body: { text: string, detailed?, preferredModel? }
 * Response: { sentiment, score, confidence, emotions, tone, intent, summary, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedSentiment } from '../../flows/enhanced-sentiment';

export async function sentimentHandler(req: Request, res: Response): Promise<void> {
  try {
    const { text, detailed, preferredModel } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'MISSING_TEXT', message: 'text is required and must be a string' });
      return;
    }
    const result = await enhancedSentiment({ text, detailed, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'SENTIMENT_FAILED', message: error instanceof Error ? error.message : 'Sentiment analysis failed' });
  }
}
