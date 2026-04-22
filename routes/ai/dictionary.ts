/**
 * POST /api/ai/dictionary
 * Word definitions, synonyms, antonyms, and etymology.
 * Body: { word: string, language?, includeEtymology?, preferredModel? }
 * Response: { word, definitions, synonyms, antonyms, etymology, ... }
 */
import type { Request, Response } from 'express';
import { enhancedDictionary } from '../../flows/enhanced-dictionary';

export async function dictionaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const { word, language, includeEtymology, preferredModel } = req.body;
    if (!word || typeof word !== 'string') {
      res.status(400).json({ error: 'MISSING_WORD', message: 'word is required and must be a string' });
      return;
    }
    const result = await enhancedDictionary({ word, language, includeEtymology, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'DICTIONARY_FAILED', message: error instanceof Error ? error.message : 'Dictionary lookup failed' });
  }
}
