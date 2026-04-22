# SOHAM Search System — Complete Documentation

## Overview

SOHAM's search is a **6-step pipeline** powered by **Tavily** (primary search) and **Firecrawl** (deep content extraction), with free fallbacks always available.

```
User Query
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1  Query Analysis                                         │
│  Classify type, extract entities, clean search terms            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2  Source Selection                                       │
│  Tavily (primary) → Firecrawl (enrichment) → free fallbacks    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3  Parallel Fetch + Firecrawl Enrichment                  │
│  Tavily returns ranked results (8 URLs)                         │
│  Firecrawl scrapes top 3 URLs → full markdown content           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4  Result Merge & Rank                                    │
│  Deduplicate by URL, score by source quality, cap at 10         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5  AI Synthesis                                           │
│  Feed results + Firecrawl full content to AI                    │
│  Temperature: 0.3 (factual accuracy mode)                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 6  Citation Build                                         │
│  Attach [1][2][3] numbered source references                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
                    Final Answer
```

---

## Source Tiers

| Tier | Source | Key | Quality | Role |
|------|--------|-----|---------|------|
| **1 — Primary** | **Tavily** | `TAVILY_API_KEY` | ⭐⭐⭐⭐⭐ | Real-time web search, AI-optimised |
| **1 — Enrichment** | **Firecrawl** | `FIRECRAWL_API_KEY` | ⭐⭐⭐⭐⭐ | Full page content extraction |
| 2 — Domain | GNews | `GNEWS_API_KEY` | ⭐⭐⭐⭐ | News articles |
| 2 — Domain | CricAPI | `CRICAPI_KEY` | ⭐⭐⭐⭐ | Live cricket / sports |
| 2 — Domain | Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | ⭐⭐⭐⭐ | Stock prices |
| 3 — Free | Wikipedia | none | ⭐⭐⭐⭐ | Encyclopedic / factual |
| 3 — Free | DuckDuckGo | none | ⭐⭐⭐ | General fallback |
| 3 — Free | Open-Meteo | none | ⭐⭐⭐⭐⭐ | Weather |
| 3 — Free | CoinGecko | none | ⭐⭐⭐⭐⭐ | Crypto prices |

**Minimum viable:** No keys needed — DuckDuckGo + Wikipedia + Open-Meteo + CoinGecko always work.
**Recommended:** `TAVILY_API_KEY` + `FIRECRAWL_API_KEY` for best results.

---

## Step 1 — Query Analysis

**File:** `server/tools/search-engine.ts` → `analyzeQuery()`

Classifies the query into one of 7 types:

| Type | Trigger Keywords | Sources Used |
|------|-----------------|--------------|
| `news` | news, headlines, breaking, latest, today | Tavily (news topic) + GNews |
| `weather` | weather, temperature, forecast, rain | Open-Meteo |
| `finance` | stock, crypto, bitcoin, market, price | CoinGecko + Alpha Vantage |
| `sports` | cricket, football, match, score, ipl | CricAPI |
| `factual` | who, what, when, where, define, explain | Tavily + Wikipedia |
| `realtime` | today, now, current, live, breaking | Tavily (advanced depth) |
| `general` | (default) | Tavily + Wikipedia |

Also extracts:
- `cleanQuery` — removes filler words ("search for", "tell me about", etc.)
- `extractedEntities` — capitalized proper nouns
- `searchTerms` — meaningful keywords
- `isTimeSensitive` — boolean flag
- `isFactual` — boolean flag

---

## Step 2 — Source Selection

**File:** `server/tools/search-engine.ts` → `selectSources()`

- Tavily is always first when configured — it handles every query type
- Firecrawl is added automatically when both `TAVILY_API_KEY` and `FIRECRAWL_API_KEY` are set
- Domain-specific sources (GNews, CricAPI, etc.) are added based on query type
- DuckDuckGo is the last-resort fallback when Tavily is not configured

---

## Step 3 — Parallel Fetch + Firecrawl Enrichment

**File:** `server/tools/search-engine.ts` → `runSearchPipeline()`

### 3a — Tavily Search

Tavily is purpose-built for AI agents. It returns:
- Ranked results with relevance scores (0–1)
- Clean snippets (no HTML)
- Published dates
- An optional AI-generated answer (`include_answer: true`)

Search depth is tuned per query type:
- `realtime` / `news` → `advanced` depth (slower but more thorough)
- everything else → `basic` depth (faster)

### 3b — Firecrawl Enrichment

After Tavily returns results, Firecrawl scrapes the **top 3 URLs** in parallel and extracts full page content as clean markdown.

```
Tavily results (8 URLs with snippets)
         │
         ▼
Firecrawl.scrape(URL 1)  ─┐
Firecrawl.scrape(URL 2)  ─┼─ parallel, 12s timeout each
Firecrawl.scrape(URL 3)  ─┘
         │
         ▼
Results enriched with fullContent (up to 2000 chars each)
```

This gives the AI **full article text** instead of just snippets — dramatically improving answer quality for complex queries.

### 3c — Free fallbacks

- **DuckDuckGo** — instant answer API, no key, limited results
- **Wikipedia** — search + page summary for factual queries
- **Open-Meteo** — geocoding + weather API, completely free
- **CoinGecko** — crypto prices, completely free

All sources have a **6-second timeout** — slow sources are silently skipped.

---

## Step 4 — Result Merge & Rank

**File:** `server/tools/search-engine.ts` → `mergeAndRank()`

1. Sort all results by `score` descending — Tavily results naturally float to top
2. Deduplicate by normalized URL
3. Remove results with empty title or URL
4. Cap at 10 results

Score assignment:
- Tavily: uses Tavily's own relevance score (0–1)
- GNews: 0.90 → 0.65 (position-weighted)
- Wikipedia: 0.80 → 0.55
- DuckDuckGo: 0.75 / 0.55 (direct vs related)
- Domain tools (weather, crypto, stocks): 1.0 (always top)

---

## Step 5 — AI Synthesis

**File:** `server/flows/search-pipeline.ts` → `runFullSearchPipeline()`

The synthesis prompt includes both snippets AND Firecrawl full content:

```
Answer the following question using ONLY the search results provided below.
Be accurate, cite sources using [1], [2], etc., and be concise.

Question: {query}

Quick Answer: {Tavily's own answer if available}

Search Results:
[1] {title}
    {snippet}
    --- Full page content (via Firecrawl) ---
    {full markdown content up to 2000 chars}
    ---
    Published: {date}
    URL: {url}

[2] {title}
    {snippet}
    URL: {url}
...
```

**AI settings:**
- Temperature: `0.3` (factual accuracy mode)
- TopP: `0.9`
- MaxTokens: `1024`
- Model: user-specified or smart fallback (Groq → Cerebras → Google → HF)

If AI synthesis fails, the pipeline falls back to returning raw results directly.

---

## Step 6 — Citation Build

**File:** `server/flows/search-pipeline.ts` → `buildCitationBlock()`

Appends a formatted sources block to the AI answer:

```
**Sources:**
[1] [Article Title](https://example.com) — 2025-04-18
[2] [Another Source](https://another.com)
```

---

## API Reference

### `POST /api/ai/search`

**Request:**
```json
{
  "query": "latest developments in quantum computing",
  "preferredModel": "llama-3.1-8b-instant",
  "maxResults": 8,
  "includeTrace": true
}
```

**Response:**
```json
{
  "success": true,
  "answer": "Quantum computing has seen major advances in 2025... [1][2]\n\n**Sources:**\n[1] [IBM Quantum](https://ibm.com/...)",
  "sources": [
    {
      "index": 1,
      "title": "IBM Announces 1000-Qubit Processor",
      "url": "https://ibm.com/...",
      "snippet": "IBM today announced...",
      "source": "tavily",
      "publishedAt": "2025-04-15"
    }
  ],
  "queryType": "realtime",
  "modelUsed": "llama-3.1-8b-instant",
  "searchTimeMs": 2400,
  "totalSources": 6,
  "stepTrace": {
    "step1_queryAnalysis": { "queryType": "realtime", "cleanQuery": "latest developments quantum computing" },
    "step2_sourcesSelected": ["tavily", "firecrawl", "wikipedia"],
    "step3_rawResults": 12,
    "step4_mergedResults": 8,
    "step5_aiSynthesis": "Used model: llama-3.1-8b-instant",
    "step6_citationsAdded": 8
  },
  "responseTime": "3100ms",
  "timestamp": "2025-04-18T12:00:00.000Z"
}
```

**Error Responses:**

| Status | Error Code | Cause |
|--------|-----------|-------|
| 400 | `MISSING_QUERY` | No query provided |
| 400 | `EMPTY_QUERY` | Query is blank |
| 400 | `QUERY_TOO_LONG` | Query > 500 chars |
| 500 | `SEARCH_FAILED` | Pipeline error |

---

## Environment Variables

```env
# PRIMARY (recommended)
TAVILY_API_KEY=          # https://app.tavily.com
FIRECRAWL_API_KEY=       # https://www.firecrawl.dev

# DOMAIN-SPECIFIC (optional)
GNEWS_API_KEY=           # https://gnews.io
CRICAPI_KEY=             # https://cricapi.com
ALPHA_VANTAGE_API_KEY=   # https://alphavantage.co

# FREE FALLBACKS (no key needed — always active)
# Wikipedia, DuckDuckGo, Open-Meteo, CoinGecko
```

---

## File Structure

```
server/
├── tools/
│   ├── search-engine.ts   ← Steps 1-4 (Tavily + Firecrawl + fallbacks)
│   ├── duckduckgo.ts      ← DuckDuckGo client (kept for agent-tools.ts)
│   └── agent-tools.ts     ← Tool intent detection (news/weather/sports/finance)
├── flows/
│   ├── search-pipeline.ts ← Steps 5-6 (AI synthesis + citations)
│   └── enhanced-search.ts ← Legacy wrapper
└── routes/
    └── ai/
        └── search.ts      ← Express route handler
```

---

## How Search Integrates with Chat

```
User: "what's the latest news about AI?"
         │
         ▼
   IntentDetector.detect()
         │  intent = WEB_SEARCH (confidence: 0.85)
         ▼
   runFullSearchPipeline({ query: "latest news about AI" })
         │  Tavily → Firecrawl → AI synthesis
         ▼
   Result injected into chat context as TOOL_RESULT block
         │
         ▼
   AI generates response grounded in real search data
```

---

## Adding a New Search Source

1. Add fetch function in `server/tools/search-engine.ts`:
```typescript
async function fetchMySource(query: string): Promise<SearchResult[]> {
  const key = process.env.MY_SOURCE_API_KEY;
  if (!key) return [];
  // fetch and return SearchResult[]
}
```

2. Register in `isConfigured()`:
```typescript
case 'my-source': return !!process.env.MY_SOURCE_API_KEY;
```

3. Add to `selectSources()` for relevant query types.

4. Add fetch call in `runSearchPipeline()` fetch jobs array.

The merge, rank, synthesis, and citation steps handle the rest automatically.
