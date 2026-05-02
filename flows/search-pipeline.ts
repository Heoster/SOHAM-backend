/**
 * SOHAM Search Pipeline — Full 6-Step Flow
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  STEP 1  Query Analysis                                                 │
 * │          Classify type, extract entities, clean search terms            │
 * │                          ↓                                              │
 * │  STEP 2  Source Selection                                               │
 * │          Tavily (primary) → Firecrawl (enrichment) → free fallbacks    │
 * │                          ↓                                              │
 * │  STEP 3  Parallel Fetch + Firecrawl Enrichment                         │
 * │          Tavily returns ranked results; Firecrawl extracts full content │
 * │          from the top URLs so the AI has richer context                 │
 * │                          ↓                                              │
 * │  STEP 4  Result Merge & Rank                                            │
 * │          Deduplicate, score, normalize into unified format              │
 * │                          ↓                                              │
 * │  STEP 5  AI Synthesis                                                   │
 * │          Feed results + full content to AI → grounded answer           │
 * │                          ↓                                              │
 * │  STEP 6  Citation Build                                                 │
 * │          Attach numbered [1][2][3] source references                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Required env vars:
 *   TAVILY_API_KEY     https://app.tavily.com
 *   FIRECRAWL_API_KEY  https://www.firecrawl.dev  (optional but recommended)
 */

import { runSearchPipeline, type SearchResult, type QueryType } from '../tools/search-engine';
import { generateWithSmartFallback } from '../routing/smart-fallback';
import { withDateTime } from '../memory/realtime-knowledge-service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchPipelineInput {
  query: string;
  preferredModel?: string;
  maxResults?: number;
  includeStepTrace?: boolean; // return step-by-step trace in response
}

export interface SearchPipelineOutput {
  answer: string;
  sources: Array<{
    index: number;
    title: string;
    url: string;
    snippet: string;
    source: string;
    publishedAt?: string;
  }>;
  queryType: QueryType;
  modelUsed?: string;
  searchTimeMs: number;
  totalSources: number;
  // Step trace (only when includeStepTrace: true)
  stepTrace?: {
    step1_queryAnalysis: object;
    step2_sourcesSelected: string[];
    step3_rawResults: number;
    step4_mergedResults: number;
    step5_aiSynthesis: string;
    step6_citationsAdded: number;
  };
}

// ─── Step 5: AI Synthesis Prompt Builder ─────────────────────────────────────

function buildSynthesisPrompt(query: string, results: SearchResult[], abstract?: string): string {
  const lines: string[] = [];

  lines.push(`Answer the following question using ONLY the search results provided below.`);
  lines.push(`Be accurate, cite sources using [1], [2], etc., and be concise.\n`);
  lines.push(`Question: ${query}\n`);

  if (abstract) {
    lines.push(`Quick Answer: ${abstract}\n`);
  }

  if (results.length > 0) {
    lines.push(`Search Results:`);
    results.forEach((r, i) => {
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    ${r.snippet}`);
      // Include Firecrawl full content when available — gives AI much richer context
      if (r.fullContent) {
        lines.push(`    --- Full page content (via Firecrawl) ---`);
        lines.push(`    ${r.fullContent.replace(/\n/g, '\n    ')}`);
        lines.push(`    ---`);
      }
      if (r.publishedAt) lines.push(`    Published: ${r.publishedAt}`);
      lines.push(`    URL: ${r.url}`);
      lines.push('');
    });
  } else {
    lines.push(`No search results were found. Answer from your training knowledge, but note this may not be current.`);
  }

  return lines.join('\n');
}

const SYNTHESIS_SYSTEM_PROMPT = `You are SOHAM's search synthesis engine. Your job is to produce accurate, well-structured answers from web search results.

Rules:
- Use ONLY information from the provided search results
- Cite sources inline using [1], [2], [3] notation
- If results are insufficient, say so clearly and answer from training knowledge
- Start with a direct answer, then provide supporting details
- Use bullet points for lists, bold for key terms
- NEVER use markdown headers (# ## ###)
- Calibrate length to the query: simple factual questions get 1-3 sentences; complex topics get up to 500 words
- If the query is time-sensitive, mention the date/recency of sources
- For news queries, summarize the key facts from multiple sources
- For factual queries, be precise and cite the most authoritative source first`;

function buildCitationBlock(results: SearchResult[]): string {
  if (results.length === 0) return '';
  const lines = ['\n\n**Sources:**'];
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] [${r.title}](${r.url})${r.publishedAt ? ` — ${r.publishedAt}` : ''}`);
  });
  return lines.join('\n');
}

// ─── Main Pipeline Function ───────────────────────────────────────────────────

export async function runFullSearchPipeline(input: SearchPipelineInput): Promise<SearchPipelineOutput> {
  const pipelineStart = Date.now();
  const { query, preferredModel, maxResults = 8, includeStepTrace = false } = input;

  console.log(`\n[SearchPipeline] ═══ Starting search: "${query}" ═══`);

  // ── Steps 1–4: Search Engine ──────────────────────────────────────────────
  const searchResult = await runSearchPipeline(query);
  const topResults = searchResult.results.slice(0, maxResults);

  console.log(`[SearchPipeline] Step 1-4 complete — ${topResults.length} results in ${searchResult.searchTimeMs}ms`);
  console.log(`[SearchPipeline] Query type: ${searchResult.queryType}`);
  console.log(`[SearchPipeline] Sources used: ${searchResult.sourcesUsed.join(', ')}`);

  // ── Step 5: AI Synthesis ──────────────────────────────────────────────────
  console.log(`[SearchPipeline] Step 5 — AI synthesis starting...`);
  const synthesisPrompt = buildSynthesisPrompt(query, topResults, searchResult.abstract);

  let aiAnswer = '';
  let modelUsed: string | undefined;

  try {
    const aiResult = await generateWithSmartFallback({
      prompt: synthesisPrompt,
      systemPrompt: withDateTime(SYNTHESIS_SYSTEM_PROMPT),
      preferredModelId: preferredModel,
      category: 'general',
      params: {
        temperature: 0.3,  // low temp for factual accuracy
        topP: 0.9,
        maxOutputTokens: 1024,
      },
    });
    aiAnswer = aiResult.response.text;
    modelUsed = aiResult.modelUsed;
    console.log(`[SearchPipeline] Step 5 — AI synthesis done (model: ${modelUsed})`);
  } catch (err) {
    // Fallback: return raw results without AI synthesis
    console.warn(`[SearchPipeline] Step 5 — AI synthesis failed, using raw results:`, err);
    if (searchResult.abstract) {
      aiAnswer = searchResult.abstract;
    } else if (topResults.length > 0) {
      aiAnswer = topResults
        .slice(0, 3)
        .map((r, i) => `[${i + 1}] **${r.title}**\n${r.snippet}`)
        .join('\n\n');
    } else {
      aiAnswer = `No results found for "${query}". Please try a different search query.`;
    }
  }

  // ── Step 6: Citation Build ────────────────────────────────────────────────
  const citationBlock = buildCitationBlock(topResults);
  const finalAnswer = aiAnswer + citationBlock;
  console.log(`[SearchPipeline] Step 6 — Citations added (${topResults.length} sources)`);

  const totalTimeMs = Date.now() - pipelineStart;
  console.log(`[SearchPipeline] ═══ Complete in ${totalTimeMs}ms ═══\n`);

  // ── Build output ──────────────────────────────────────────────────────────
  const output: SearchPipelineOutput = {
    answer: finalAnswer,
    sources: topResults.map((r, i) => ({
      index: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      source: r.source,
      publishedAt: r.publishedAt,
    })),
    queryType: searchResult.queryType,
    modelUsed,
    searchTimeMs: totalTimeMs,
    totalSources: topResults.length,
  };

  if (includeStepTrace) {
    output.stepTrace = {
      step1_queryAnalysis:   searchResult.steps.queryAnalysis,
      step2_sourcesSelected: searchResult.steps.sourcesSelected,
      step3_rawResults:      searchResult.steps.rawResultCount,
      step4_mergedResults:   searchResult.steps.mergedResultCount,
      step5_aiSynthesis:     `Used model: ${modelUsed ?? 'fallback'}`,
      step6_citationsAdded:  topResults.length,
    };
  }

  return output;
}
