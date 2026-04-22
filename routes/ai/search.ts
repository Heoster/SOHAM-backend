/**
 * POST /api/ai/search
 * ════════════════════════════════════════════════════════════════════════════
 * SOHAM Search Endpoint — Full 6-Step Pipeline
 *
 * Sources:
 *   Tavily (primary, real-time)  →  TAVILY_API_KEY
 *   Firecrawl (deep extraction)  →  FIRECRAWL_API_KEY
 *   GNews / CricAPI / Alpha Vantage (domain-specific, optional)
 *   Wikipedia + DuckDuckGo (free fallbacks, always available)
 *
 * Request Body:
 * ┌─────────────────┬──────────┬──────────────────────────────────────────┐
 * │ query           │ string   │ REQUIRED. The search query               │
 * │ preferredModel  │ string   │ Optional. AI model ID for synthesis      │
 * │ maxResults      │ number   │ Optional. Max results (default: 8)       │
 * │ includeTrace    │ boolean  │ Optional. Return step-by-step trace      │
 * └─────────────────┴──────────┴──────────────────────────────────────────┘
 *
 * Response:
 * ┌─────────────────┬──────────────────────────────────────────────────────┐
 * │ answer          │ AI-synthesized answer with [1][2] citations          │
 * │ sources         │ Array of { index, title, url, snippet, source }      │
 * │ queryType       │ news | factual | realtime | general | weather | ...  │
 * │ modelUsed       │ Which AI model synthesized the answer                │
 * │ searchTimeMs    │ Total pipeline time in milliseconds                  │
 * │ totalSources    │ Number of sources used                               │
 * │ stepTrace       │ (optional) Step-by-step pipeline trace               │
 * └─────────────────┴──────────────────────────────────────────────────────┘
 *
 * Pipeline Steps:
 *   Step 1 → Query Analysis   (type, entities, clean terms)
 *   Step 2 → Source Selection (Tavily → Firecrawl → domain tools → free fallbacks)
 *   Step 3 → Parallel Fetch   (Tavily) + Firecrawl enrichment on top URLs
 *   Step 4 → Merge & Rank     (deduplicate, score)
 *   Step 5 → AI Synthesis     (grounded answer from results + full content)
 *   Step 6 → Citation Build   ([1][2][3] references)
 */

import type { Request, Response } from 'express';
import { runFullSearchPipeline } from '../../flows/search-pipeline';

export async function searchHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    // ── Validation ──────────────────────────────────────────────────────────
    const { query, preferredModel, maxResults, includeTrace } = req.body;

    if (!query || typeof query !== 'string') {
      res.status(400).json({
        error: 'MISSING_QUERY',
        message: 'query is required and must be a string',
        example: { query: 'latest AI news', preferredModel: 'llama-3.1-8b-instant' },
      });
      return;
    }

    if (query.trim().length === 0) {
      res.status(400).json({ error: 'EMPTY_QUERY', message: 'query cannot be empty' });
      return;
    }

    if (query.length > 500) {
      res.status(400).json({ error: 'QUERY_TOO_LONG', message: 'query must be under 500 characters' });
      return;
    }

    // ── Run Pipeline ────────────────────────────────────────────────────────
    const result = await runFullSearchPipeline({
      query: query.trim(),
      preferredModel: typeof preferredModel === 'string' ? preferredModel : undefined,
      maxResults: typeof maxResults === 'number' ? Math.min(maxResults, 15) : 8,
      includeStepTrace: includeTrace === true,
    });

    // ── Response ────────────────────────────────────────────────────────────
    res.json({
      success: true,
      ...result,
      responseTime: `${Date.now() - startTime}ms`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[Search API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'SEARCH_FAILED',
      message: error instanceof Error ? error.message : 'Search pipeline failed',
      responseTime: `${Date.now() - startTime}ms`,
      timestamp: new Date().toISOString(),
    });
  }
}
