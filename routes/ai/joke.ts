/**
 * POST /api/ai/joke
 * Joke, pun, roast, compliment, riddle, and fun fact generator.
 * Body: { topic?, type?, style?, count?, preferredModel? }
 * Response: { items, count, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedJoke } from '../../flows/enhanced-joke';

export async function jokeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { topic, type, style, count, preferredModel } = req.body;
    const result = await enhancedJoke({ topic, type, style, count, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'JOKE_FAILED', message: error instanceof Error ? error.message : 'Joke generation failed' });
  }
}
