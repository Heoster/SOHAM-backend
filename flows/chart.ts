/**
 * Chart Pipeline
 * ════════════════════════════════════════════════════════════════════════════
 * For "compare X and Y — and draw a chart" requests.
 *
 * Why this exists: the image-generation pipeline can't render truthful data
 * (it hallucinates a random picture and says "here's your image!"). Instead:
 *
 *   1. The LLM proposes a STRICT JSON series: { title, unit, note, items[] }.
 *      For well-known public stats (e.g. city populations) it must use commonly
 *      published estimates and label the note as approximate.
 *   2. tools/chart-generator.ts validates the series, then renders the chart
 *      and the markdown table DETERMINISTICALLY from the same numbers — the
 *      chart can never disagree with the table, and no diffusion model is
 *      involved.
 *
 * The client renders the SVG data URI as an <img>, exactly like the image
 * pipeline's image event.
 */

import { generateWithFallback } from '../routing/multi-provider-router';
import { withDateTime } from '../memory/realtime-knowledge-service';
import {
  parseChartJson,
  specToMarkdownTable,
  specToSvgDataUri,
  type ChartItem,
} from '../tools/chart-generator';

export interface ChartRunResult {
  title: string;
  unit?: string;
  note?: string;
  items: ChartItem[];
  tableMarkdown: string;
  /** data:image/svg+xml;base64,... — drop straight into an <img src> */
  imageDataUri: string;
  modelUsed?: string;
}

export interface ChartRunInput {
  query: string;
  preferredModel?: string;
}

export async function runChartPipeline(input: ChartRunInput): Promise<ChartRunResult> {
  const query = input.query.trim().slice(0, 500);
  if (!query) throw new Error('Chart query is empty');

  const systemPrompt = withDateTime(
    'You are a data-to-chart engine. Turn the user\'s data/comparison request into ONE strict JSON object. ' +
    'Rules: use commonly published estimates for well-known public statistics (e.g. UN World Urbanization ' +
    'Prospects, Census of India) and say so in "note" (e.g. "Approx. UN 2024 urban-agglomeration estimates"). ' +
    'Never fabricate precise-looking figures for private/internal data you cannot know — in that case return ' +
    'items with your best clearly-labelled estimates and mark the note as illustrative. ' +
    'Items must be sorted descending and capped at 8. Return ONLY valid JSON, no markdown fences, no prose.',
  );

  const prompt = `Convert this request into a chart spec:
"""${query}"""

Respond with ONLY this JSON object:
{
  "title": "<short chart title, max 80 chars>",
  "unit": "<unit of values, e.g. population, USD, % — omit if unitless>",
  "note": "<one line source/approximation note, max 160 chars>",
  "items": [
    { "label": "<name, max 40 chars>", "value": <number> }
  ]
}

Requirements: 2 to 8 items, sorted descending by value, finite numbers only (no strings, no units in values).`;

  const response = await generateWithFallback({
    prompt,
    systemPrompt,
    preferredModelId: input.preferredModel,
    category: 'general',
    params: { temperature: 0.2, maxOutputTokens: 1024 },
  });

  const spec = parseChartJson(response.text);
  if (!spec) {
    throw new Error('Chart data extraction failed — the model did not return a valid JSON series');
  }

  return {
    title: spec.title,
    unit: spec.unit,
    note: spec.note,
    items: spec.items,
    tableMarkdown: specToMarkdownTable(spec),
    imageDataUri: specToSvgDataUri(spec),
    modelUsed: response.modelUsed,
  };
}
