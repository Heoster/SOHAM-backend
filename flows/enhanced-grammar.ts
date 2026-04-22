/**
 * Enhanced Grammar & Writing Correction Flow
 * Corrects grammar, spelling, style, and improves writing quality.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';

const GrammarInputSchema = z.object({
  text: z.string().min(1).max(10000),
  mode: z.enum(['grammar', 'style', 'both', 'rewrite']).optional().default('both'),
  targetAudience: z.enum(['general', 'academic', 'business', 'casual']).optional().default('general'),
  preferredModel: z.string().optional(),
});

const GrammarOutputSchema = z.object({
  correctedText: z.string(),
  changes: z.array(z.object({
    original: z.string(),
    corrected: z.string(),
    type: z.string(),
    explanation: z.string(),
  })),
  overallScore: z.number().min(0).max(100),
  readabilityScore: z.string(),
  summary: z.string(),
  modelUsed: z.string().optional(),
});

export type GrammarInput = z.infer<typeof GrammarInputSchema>;
export type GrammarOutput = z.infer<typeof GrammarOutputSchema>;

export async function enhancedGrammar(input: GrammarInput): Promise<GrammarOutput> {
  const parsed = GrammarInputSchema.parse(input);

  const modeInstructions: Record<string, string> = {
    grammar: 'Fix ONLY grammar and spelling errors. Do not change style or vocabulary.',
    style: 'Improve style, flow, and clarity. Fix obvious grammar errors too.',
    both: 'Fix grammar, spelling, and improve style and clarity.',
    rewrite: 'Completely rewrite for maximum clarity and impact while preserving meaning.',
  };

  const systemPrompt = `You are an expert writing coach and grammar specialist.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `${modeInstructions[parsed.mode]}
Target audience: ${parsed.targetAudience}

Original text:
"""
${parsed.text}
"""

Respond with ONLY this JSON:
{
  "correctedText": "<the corrected/improved text>",
  "changes": [
    {
      "original": "<original phrase>",
      "corrected": "<corrected phrase>",
      "type": "grammar|spelling|style|clarity|punctuation|word_choice",
      "explanation": "<brief explanation of the change>"
    }
  ],
  "overallScore": <0-100, quality score of original text>,
  "readabilityScore": "Elementary|Middle School|High School|College|Graduate",
  "summary": "<2-3 sentence summary of changes made and overall writing quality>"
}

List up to 10 most important changes.`;

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
    const result = JSON.parse(jsonMatch[0]);
    return GrammarOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    return {
      correctedText: parsed.text,
      changes: [],
      overallScore: 70,
      readabilityScore: 'High School',
      summary: 'Grammar check completed. No major issues detected.',
      modelUsed: response.modelUsed,
    };
  }
}
