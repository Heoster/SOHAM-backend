/**
 * Enhanced Dictionary / Word Lookup Flow
 * Provides definitions, synonyms, antonyms, etymology, and usage examples.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';
import { withDateTime } from '../memory/realtime-knowledge-service';


const DictionaryInputSchema = z.object({
  word: z.string().min(1).max(100),
  language: z.string().optional().default('English'),
  includeEtymology: z.boolean().optional().default(true),
  preferredModel: z.string().optional(),
});

const DictionaryOutputSchema = z.object({
  word: z.string(),
  language: z.string(),
  pronunciation: z.string(),
  partOfSpeech: z.array(z.string()),
  definitions: z.array(z.object({
    partOfSpeech: z.string(),
    definition: z.string(),
    example: z.string(),
  })),
  synonyms: z.array(z.string()),
  antonyms: z.array(z.string()),
  etymology: z.string().optional(),
  usageNotes: z.string().optional(),
  relatedWords: z.array(z.string()),
  modelUsed: z.string().optional(),
});

export type DictionaryInput = z.infer<typeof DictionaryInputSchema>;
export type DictionaryOutput = z.infer<typeof DictionaryOutputSchema>;

export async function enhancedDictionary(input: DictionaryInput): Promise<DictionaryOutput> {
  const parsed = DictionaryInputSchema.parse(input);

  const systemPrompt = `You are a comprehensive dictionary and linguistics expert.
Provide accurate, detailed word information including definitions, usage, and etymology.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `Look up the word: "${parsed.word}" in ${parsed.language}

Respond with ONLY this JSON:
{
  "word": "${parsed.word}",
  "language": "${parsed.language}",
  "pronunciation": "<IPA or phonetic pronunciation>",
  "partOfSpeech": ["noun", "verb", ...],
  "definitions": [
    {
      "partOfSpeech": "noun",
      "definition": "<clear definition>",
      "example": "<example sentence using the word>"
    }
  ],
  "synonyms": ["<synonym1>", "<synonym2>", ...],
  "antonyms": ["<antonym1>", "<antonym2>", ...],
  ${parsed.includeEtymology ? '"etymology": "<word origin and history>",' : ''}
  "usageNotes": "<any special usage notes, common mistakes, or context>",
  "relatedWords": ["<related word 1>", "<related word 2>", ...]
}

Provide up to 5 definitions, 8 synonyms, 5 antonyms, and 5 related words.`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt: withDateTime(systemPrompt),
    preferredModelId: parsed.preferredModel,
    category: 'general',
    params: { temperature: 0.2, maxOutputTokens: 2048 },
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const result = JSON.parse(jsonMatch[0]);
    return DictionaryOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    throw new Error(`Could not look up "${parsed.word}". Please check the spelling and try again.`);
  }
}
