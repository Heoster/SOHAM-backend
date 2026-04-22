/**
 * Enhanced Joke / Roast / Compliment Generator Flow
 * Generates jokes, roasts, compliments, and fun content.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';

const JokeInputSchema = z.object({
  topic: z.string().optional().default('anything'),
  type: z.enum(['joke', 'pun', 'roast', 'compliment', 'pickup_line', 'riddle', 'fun_fact']).optional().default('joke'),
  style: z.enum(['clean', 'witty', 'sarcastic', 'wholesome', 'nerdy', 'dad_joke']).optional().default('witty'),
  count: z.number().min(1).max(10).optional().default(1),
  preferredModel: z.string().optional(),
});

const JokeOutputSchema = z.object({
  items: z.array(z.object({
    type: z.string(),
    content: z.string(),
    punchline: z.string().optional(),
    answer: z.string().optional(),
  })),
  count: z.number(),
  modelUsed: z.string().optional(),
});

export type JokeInput = z.infer<typeof JokeInputSchema>;
export type JokeOutput = z.infer<typeof JokeOutputSchema>;

export async function enhancedJoke(input: JokeInput): Promise<JokeOutput> {
  const parsed = JokeInputSchema.parse(input);

  const typeDescriptions: Record<string, string> = {
    joke: 'funny jokes with setup and punchline',
    pun: 'clever wordplay puns',
    roast: 'light-hearted, friendly roasts (never mean-spirited)',
    compliment: 'genuine, creative compliments',
    pickup_line: 'cheesy but charming pickup lines',
    riddle: 'clever riddles with answers',
    fun_fact: 'surprising and interesting fun facts',
  };

  const systemPrompt = `You are a witty comedian and entertainer. Generate ${typeDescriptions[parsed.type]}.
Keep all content clean, appropriate, and fun. Never offensive or harmful.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `Generate ${parsed.count} ${parsed.style} ${parsed.type}(s) about: "${parsed.topic}"

Respond with ONLY this JSON:
{
  "items": [
    {
      "type": "${parsed.type}",
      "content": "<main content / setup>",
      "punchline": "<punchline if applicable, omit for compliments/facts>",
      "answer": "<answer if riddle, omit otherwise>"
    }
  ],
  "count": ${parsed.count}
}`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt,
    preferredModelId: parsed.preferredModel,
    category: 'general',
    params: { temperature: 0.9, maxOutputTokens: 2048 },
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const result = JSON.parse(jsonMatch[0]);
    return JokeOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    return {
      items: [{ type: parsed.type, content: response.text.trim() }],
      count: 1,
      modelUsed: response.modelUsed,
    };
  }
}
