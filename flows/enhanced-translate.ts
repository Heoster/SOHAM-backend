/**
 * Enhanced Translation Flow
 * Translates text between languages using AI with optional auto-detection.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';

const TranslateInputSchema = z.object({
  text: z.string().min(1).max(10000),
  targetLanguage: z.string().min(1),
  sourceLanguage: z.string().optional().default('auto'),
  preferredModel: z.string().optional(),
  tone: z.enum(['formal', 'casual', 'neutral']).optional().default('neutral'),
});

const TranslateOutputSchema = z.object({
  translatedText: z.string(),
  detectedSourceLanguage: z.string(),
  targetLanguage: z.string(),
  confidence: z.string(),
  modelUsed: z.string().optional(),
});

export type TranslateInput = z.infer<typeof TranslateInputSchema>;
export type TranslateOutput = z.infer<typeof TranslateOutputSchema>;

export async function enhancedTranslate(input: TranslateInput): Promise<TranslateOutput> {
  const parsed = TranslateInputSchema.parse(input);

  const systemPrompt = `You are a professional translator with expertise in all world languages.
Your task is to translate text accurately while preserving meaning, tone, and cultural nuances.

Rules:
- Translate ONLY the provided text, nothing else
- Preserve formatting (line breaks, bullet points, etc.)
- Maintain the original tone unless instructed otherwise
- For idiomatic expressions, use equivalent idioms in the target language
- Return ONLY valid JSON, no markdown, no extra text`;

  const prompt = `Translate the following text to ${parsed.targetLanguage}.
Source language: ${parsed.sourceLanguage === 'auto' ? 'auto-detect' : parsed.sourceLanguage}
Tone: ${parsed.tone}

Text to translate:
"""
${parsed.text}
"""

Respond with ONLY this JSON structure:
{
  "translatedText": "<translated text here>",
  "detectedSourceLanguage": "<detected or provided source language>",
  "targetLanguage": "${parsed.targetLanguage}",
  "confidence": "high|medium|low"
}`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt,
    preferredModelId: parsed.preferredModel,
    category: 'general',
    params: { temperature: 0.2, maxOutputTokens: 4096 },
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed_result = JSON.parse(jsonMatch[0]);
    return TranslateOutputSchema.parse({
      ...parsed_result,
      modelUsed: response.modelUsed,
    });
  } catch {
    // Fallback: return raw text as translation
    return {
      translatedText: response.text.trim(),
      detectedSourceLanguage: parsed.sourceLanguage === 'auto' ? 'unknown' : parsed.sourceLanguage,
      targetLanguage: parsed.targetLanguage,
      confidence: 'medium',
      modelUsed: response.modelUsed,
    };
  }
}
