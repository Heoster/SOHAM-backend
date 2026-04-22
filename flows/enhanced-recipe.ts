/**
 * Enhanced Recipe Generator / Finder Flow
 * Generates recipes based on ingredients, cuisine, dietary restrictions, etc.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';

const RecipeInputSchema = z.object({
  query: z.string().min(1).max(500),
  ingredients: z.array(z.string()).optional().default([]),
  dietary: z.array(z.string()).optional().default([]),
  cuisine: z.string().optional(),
  servings: z.number().min(1).max(20).optional().default(4),
  difficulty: z.enum(['easy', 'medium', 'hard', 'any']).optional().default('any'),
  preferredModel: z.string().optional(),
});

const RecipeOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  cuisine: z.string(),
  difficulty: z.string(),
  prepTime: z.string(),
  cookTime: z.string(),
  totalTime: z.string(),
  servings: z.number(),
  calories: z.string(),
  ingredients: z.array(z.object({ amount: z.string(), unit: z.string(), item: z.string() })),
  instructions: z.array(z.object({ step: z.number(), instruction: z.string(), tip: z.string().optional() })),
  nutritionHighlights: z.array(z.string()),
  tags: z.array(z.string()),
  modelUsed: z.string().optional(),
});

export type RecipeInput = z.infer<typeof RecipeInputSchema>;
export type RecipeOutput = z.infer<typeof RecipeOutputSchema>;

export async function enhancedRecipe(input: RecipeInput): Promise<RecipeOutput> {
  const parsed = RecipeInputSchema.parse(input);

  const systemPrompt = `You are a world-class chef and culinary expert. Create detailed, accurate, and delicious recipes.
Return ONLY valid JSON, no markdown, no extra text.`;

  const ingredientsList = parsed.ingredients.length > 0
    ? `Available ingredients: ${parsed.ingredients.join(', ')}`
    : '';
  const dietaryList = parsed.dietary.length > 0
    ? `Dietary restrictions: ${parsed.dietary.join(', ')}`
    : '';

  const prompt = `Create a recipe for: "${parsed.query}"
${ingredientsList}
${dietaryList}
${parsed.cuisine ? `Cuisine style: ${parsed.cuisine}` : ''}
Servings: ${parsed.servings}
Difficulty: ${parsed.difficulty}

Respond with ONLY this JSON:
{
  "name": "<recipe name>",
  "description": "<2-3 sentence description>",
  "cuisine": "<cuisine type>",
  "difficulty": "easy|medium|hard",
  "prepTime": "<e.g. '15 minutes'>",
  "cookTime": "<e.g. '30 minutes'>",
  "totalTime": "<e.g. '45 minutes'>",
  "servings": ${parsed.servings},
  "calories": "<e.g. '~350 per serving'>",
  "ingredients": [
    { "amount": "2", "unit": "cups", "item": "all-purpose flour" }
  ],
  "instructions": [
    { "step": 1, "instruction": "<detailed step>", "tip": "<optional pro tip>" }
  ],
  "nutritionHighlights": ["<e.g. 'High in protein'>"],
  "tags": ["<e.g. 'vegetarian', 'quick', 'comfort food'>"]
}`;

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
    return RecipeOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    throw new Error('Failed to generate recipe. Please try again with a more specific query.');
  }
}
