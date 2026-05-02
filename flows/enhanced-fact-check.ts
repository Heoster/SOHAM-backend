/**
 * Enhanced Fact-Check Flow
 * Verifies claims using web search and AI reasoning.
 */

import { z } from 'zod';
import { generateWithFallback } from '../routing/multi-provider-router';
import { searchDuckDuckGo } from '../tools/duckduckgo';
import { withDateTime } from '../memory/realtime-knowledge-service';

const FactCheckInputSchema = z.object({
  claim: z.string().min(1).max(2000),
  preferredModel: z.string().optional(),
});

const FactCheckOutputSchema = z.object({
  claim: z.string(),
  verdict: z.enum(['true', 'false', 'mostly_true', 'mostly_false', 'unverifiable', 'misleading']),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  evidence: z.array(z.object({ point: z.string(), supports: z.boolean() })),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
  nuance: z.string(),
  modelUsed: z.string().optional(),
});

export type FactCheckInput = z.infer<typeof FactCheckInputSchema>;
export type FactCheckOutput = z.infer<typeof FactCheckOutputSchema>;

export async function enhancedFactCheck(input: FactCheckInput): Promise<FactCheckOutput> {
  const parsed = FactCheckInputSchema.parse(input);

  // Step 1: Web search for evidence
  let searchResults: Array<{ title: string; url: string; snippet: string }> = [];
  try {
    const duck = await searchDuckDuckGo(`fact check: ${parsed.claim}`);
    searchResults = duck.results.slice(0, 6).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet || '',
    }));
  } catch {
    // Continue without search results
  }

  const searchContext = searchResults.length > 0
    ? `\nWeb search results for context:\n${searchResults.map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet}`).join('\n')}`
    : '\nNo web search results available. Use your knowledge.';

  const systemPrompt = `You are an expert fact-checker with deep knowledge across all domains.
Analyze claims objectively, consider multiple perspectives, and provide evidence-based verdicts.
Return ONLY valid JSON, no markdown, no extra text.`;

  const prompt = `Fact-check this claim: "${parsed.claim}"
${searchContext}

Respond with ONLY this JSON:
{
  "claim": "${parsed.claim.replace(/"/g, '\\"')}",
  "verdict": "true|false|mostly_true|mostly_false|unverifiable|misleading",
  "confidence": <0.0-1.0>,
  "explanation": "<2-3 paragraph detailed explanation of the verdict>",
  "evidence": [
    { "point": "<specific evidence point>", "supports": true|false }
  ],
  "sources": [
    { "title": "<source title>", "url": "<url if available>" }
  ],
  "nuance": "<important context, caveats, or nuances that affect the verdict>"
}

Be objective and cite specific evidence. Include 3-5 evidence points.`;

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
    // Merge web sources if not already included
    if (result.sources?.length === 0 && searchResults.length > 0) {
      result.sources = searchResults.slice(0, 3).map(r => ({ title: r.title, url: r.url }));
    }
    return FactCheckOutputSchema.parse({ ...result, modelUsed: response.modelUsed });
  } catch {
    return {
      claim: parsed.claim,
      verdict: 'unverifiable',
      confidence: 0.3,
      explanation: 'Unable to fully verify this claim at this time.',
      evidence: [],
      sources: searchResults.slice(0, 3).map(r => ({ title: r.title, url: r.url })),
      nuance: 'Please consult authoritative sources for verification.',
      modelUsed: response.modelUsed,
    };
  }
}
