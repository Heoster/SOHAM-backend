/**
 * POST /api/ai/recipe
 * Recipe generator based on ingredients, cuisine, and dietary preferences.
 * Body: { query: string, ingredients?, dietary?, cuisine?, servings?, difficulty?, preferredModel? }
 * Response: { name, description, ingredients, instructions, ... }
 */
import type { Request, Response } from 'express';
import { enhancedRecipe } from '../../flows/enhanced-recipe';

export async function recipeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { query, ingredients, dietary, cuisine, servings, difficulty, preferredModel } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'MISSING_QUERY', message: 'query is required (e.g. "pasta carbonara", "vegan chocolate cake")' });
      return;
    }
    const result = await enhancedRecipe({ query, ingredients, dietary, cuisine, servings, difficulty, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'RECIPE_FAILED', message: error instanceof Error ? error.message : 'Recipe generation failed' });
  }
}
