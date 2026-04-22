/**
 * Enhanced Text Classification Flow
 * Classifies text into user-defined or auto-detected categories.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';

const ClassifyInputSchema = z.object({
  text: z.string().min(1).max(10000),
  categories: z.array(z.string()).optional(),
  multiLabel: z.boolean().optional().default(false),
  preferredModel: z.string().optional(),
});

const ClassifyOutputSchema = z.object({
  primaryCategory: z.string(),
  allCategories: z.array(z.object({
    category: z.string(),
    confidence: z.number(),
    reasoning: z.string(),
  })),
  isMultiLabel: z.boolean(),
  summary: z.string(),
  modelUsed: z.string().optional(),
});

export type ClassifyInput = z.infer<typeof ClassifyInputSchema>;
export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;

export async function enhancedClassify(input: ClassifyInput): Promise<ClassifyOutput> {
  const parsed = ClassifyInputSchema.parse(input);

  const categoriesSection = parsed.categories && parsed.categories.length > 0
    ? `Classify into ONE of these categories: ${parsed.categories.join(', ')}`
    : `Auto-detect the most appropriate categories from: Technology, Science, Business, Politics, Sports, Entertainment, Health, Education, Travel, Food, Art, Music, Literature, Environment, Finance, Legal, Social, Other`;

  const systemPrompt = `You are an expert text classification system. Analyze text and assign accurate categories.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `Classify the following text.
${categoriesSection}
Multi-label: ${parsed.multiLabel ? 'Yes, assign all relevant categories' : 'No, pick the single best category'}

Text:
"""
${parsed.text}
"""

Respond with ONLY this JSON:
{
  "primaryCategory": "<best matching category>",
  "allCategories": [
    { "category": "<name>", "confidence": <0.0-1.0>, "reasoning": "<brief reason>" }
  ],
  "isMultiLabel": ${parsed.multiLabel},
  "summary": "<1 sentence explaining the classification>"
}

Sort allCategories by confidence descending. Include top 3 even for single-label.`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt,
    preferredModelId: parsed.preferredModel,
    category: 'general',
    params: { temperature: 0.1, maxOutputTokens: 1024 },
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const result = JSON.parse(jsonMatch[0]);
    return ClassifyOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    return {
      primaryCategory: 'Other',
      allCategories: [{ category: 'Other', confidence: 0.5, reasoning: 'Classification failed' }],
      isMultiLabel: parsed.multiLabel,
      summary: 'Classification could not be completed.',
      modelUsed: response.modelUsed,
    };
  }
}
