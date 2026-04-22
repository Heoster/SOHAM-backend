/**
 * POST /api/ai/translate
 * Multi-language translation with auto-detection.
 * Body: { text: string, targetLanguage: string, sourceLanguage?, tone?, preferredModel? }
 * Response: { translatedText, detectedSourceLanguage, targetLanguage, confidence, modelUsed }
 */
import type { Request, Response } from 'express';
import { enhancedTranslate } from '../../flows/enhanced-translate';

export async function translateHandler(req: Request, res: Response): Promise<void> {
  try {
    const { text, targetLanguage, sourceLanguage, tone, preferredModel } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'MISSING_TEXT', message: 'text is required and must be a string' });
      return;
    }
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      res.status(400).json({ error: 'MISSING_TARGET', message: 'targetLanguage is required (e.g. "Spanish", "French", "Hindi")' });
      return;
    }
    const result = await enhancedTranslate({ text, targetLanguage, sourceLanguage, tone, preferredModel });
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'TRANSLATE_FAILED', message: error instanceof Error ? error.message : 'Translation failed' });
  }
}
