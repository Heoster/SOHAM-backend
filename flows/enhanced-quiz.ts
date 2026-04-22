/**
 * Enhanced Quiz / Flashcard Generator Flow
 * Generates quizzes, flashcards, and study materials from any topic or text.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';

const QuizInputSchema = z.object({
  topic: z.string().min(1).max(2000),
  questionCount: z.number().min(1).max(20).optional().default(5),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).optional().default('medium'),
  type: z.enum(['mcq', 'true_false', 'short_answer', 'flashcard', 'mixed']).optional().default('mcq'),
  preferredModel: z.string().optional(),
});

const QuizOutputSchema = z.object({
  title: z.string(),
  questions: z.array(z.object({
    id: z.number(),
    question: z.string(),
    type: z.string(),
    options: z.array(z.string()).optional(),
    answer: z.string(),
    explanation: z.string(),
    difficulty: z.string(),
  })),
  totalQuestions: z.number(),
  estimatedTime: z.string(),
  modelUsed: z.string().optional(),
});

export type QuizInput = z.infer<typeof QuizInputSchema>;
export type QuizOutput = z.infer<typeof QuizOutputSchema>;

export async function enhancedQuiz(input: QuizInput): Promise<QuizOutput> {
  const parsed = QuizInputSchema.parse(input);

  const typeInstructions: Record<string, string> = {
    mcq: 'Multiple choice questions with 4 options (A, B, C, D)',
    true_false: 'True/False questions',
    short_answer: 'Short answer questions (1-3 sentence answers)',
    flashcard: 'Flashcard format: front (question/term) and back (answer/definition)',
    mixed: 'Mix of MCQ, True/False, and short answer questions',
  };

  const systemPrompt = `You are an expert educator and quiz designer. Create engaging, accurate, and educational quiz content.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `Create a quiz about: "${parsed.topic}"

Format: ${typeInstructions[parsed.type]}
Number of questions: ${parsed.questionCount}
Difficulty: ${parsed.difficulty}

Respond with ONLY this JSON:
{
  "title": "<quiz title>",
  "questions": [
    {
      "id": 1,
      "question": "<question text>",
      "type": "mcq|true_false|short_answer|flashcard",
      "options": ["A. option1", "B. option2", "C. option3", "D. option4"],
      "answer": "<correct answer>",
      "explanation": "<why this is correct>",
      "difficulty": "easy|medium|hard"
    }
  ],
  "totalQuestions": ${parsed.questionCount},
  "estimatedTime": "<e.g. '5-10 minutes'>"
}

For true_false and short_answer, omit the "options" field.
For flashcards, use "question" as the front and "answer" as the back.`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt,
    preferredModelId: parsed.preferredModel,
    category: 'general',
    params: { temperature: 0.7, maxOutputTokens: 4096 },
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const result = JSON.parse(jsonMatch[0]);
    return QuizOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    return {
      title: `Quiz: ${parsed.topic}`,
      questions: [],
      totalQuestions: 0,
      estimatedTime: 'N/A',
      modelUsed: response.modelUsed,
    };
  }
}
