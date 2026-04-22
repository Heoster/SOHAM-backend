/**
 * POST /api/ai/quiz
 * Quiz and flashcard generator.
 * Body: { topic: string, questionCount?, difficulty?, type?, preferredModel? }
 * Response: { title, questions, totalQuestions, estimatedTime, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedQuiz } from '../../flows/enhanced-quiz';

export async function quizHandler(req: Request, res: Response): Promise<void> {
  try {
    const { topic, questionCount, difficulty, type, preferredModel } = req.body;
    if (!topic || typeof topic !== 'string') {
      res.status(400).json({ error: 'MISSING_TOPIC', message: 'topic is required and must be a string' });
      return;
    }
    const result = await enhancedQuiz({ topic, questionCount, difficulty, type, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'QUIZ_FAILED', message: error instanceof Error ? error.message : 'Quiz generation failed' });
  }
}
