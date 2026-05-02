/**
 * Enhanced Sentiment Analysis Flow
 * Analyzes text for sentiment, emotions, tone, and intent.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';
import { withDateTime } from '../memory/realtime-knowledge-service';


const SentimentInputSchema = z.object({
  text: z.string().min(1).max(10000),
  detailed: z.boolean().optional().default(false),
  preferredModel: z.string().optional(),
});

const SentimentOutputSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
  score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  emotions: z.array(z.object({ emotion: z.string(), intensity: z.number() })),
  tone: z.string(),
  intent: z.string(),
  summary: z.string(),
  modelUsed: z.string().optional(),
});

export type SentimentInput = z.infer<typeof SentimentInputSchema>;
export type SentimentOutput = z.infer<typeof SentimentOutputSchema>;

export async function enhancedSentiment(input: SentimentInput): Promise<SentimentOutput> {
  const parsed = SentimentInputSchema.parse(input);

  const systemPrompt = `You are an expert sentiment analysis engine. Analyze text for emotional content, tone, and intent.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `Analyze the sentiment of the following text${parsed.detailed ? ' in detail' : ''}.

Text:
"""
${parsed.text}
"""

Respond with ONLY this JSON structure:
{
  "sentiment": "positive|negative|neutral|mixed",
  "score": <number from -1.0 (very negative) to 1.0 (very positive)>,
  "confidence": <number from 0.0 to 1.0>,
  "emotions": [
    { "emotion": "<emotion name>", "intensity": <0.0-1.0> }
  ],
  "tone": "<overall tone description, e.g. 'professional', 'sarcastic', 'enthusiastic'>",
  "intent": "<detected intent, e.g. 'complaint', 'praise', 'inquiry', 'statement'>",
  "summary": "<1-2 sentence human-readable summary of the sentiment analysis>"
}

Include 3-5 emotions. Be precise with scores.`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt: withDateTime(systemPrompt),
    preferredModelId: parsed.preferredModel,
    category: 'general',
    params: { temperature: 0.1, maxOutputTokens: 1024 },
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const result = JSON.parse(jsonMatch[0]);
    return SentimentOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    return {
      sentiment: 'neutral',
      score: 0,
      confidence: 0.5,
      emotions: [{ emotion: 'neutral', intensity: 1.0 }],
      tone: 'neutral',
      intent: 'statement',
      summary: 'Unable to fully analyze sentiment. The text appears neutral.',
      modelUsed: response.modelUsed,
    };
  }
}
