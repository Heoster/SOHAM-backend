/**
 * SOHAM Search Engine
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Source priority (Steps 1-4 of the 6-step pipeline):
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  TIER 1 — Primary (needs API key)                                   │
 *   │  Tavily Search   → best real-time web search, AI-optimised results  │
 *   │  Firecrawl       → deep content extraction from specific URLs       │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │  TIER 2 — Domain-specific (needs API key)                           │
 *   │  GNews           → news articles                                    │
 *   │  CricAPI         → live cricket / sports                            │
 *   │  Alpha Vantage   → stock prices                                     │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │  TIER 3 — Always free (no key needed)                               │
 *   │  Wikipedia       → factual / encyclopedic queries                   │
 *   │  DuckDuckGo      → general fallback                                 │
 *   │  Open-Meteo      → weather (free)                                   │
 *   │  CoinGecko       → crypto prices (free)                             │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * How Tavily and Firecrawl work together:
 *   - Tavily  → runs first, returns ranked web results with snippets
 *   - Firecrawl → takes the top Tavily URLs and extracts full page content
 *                 giving the AI much richer context to synthesise from
 *
 * Required env vars:
 *   TAVILY_API_KEY      https://app.tavily.com
 *   FIRECRAWL_API_KEY   https://www.firecrawl.dev
 *
 * Optional env vars (domain-specific tools):
 *   GNEWS_API_KEY / CRICAPI_KEY / ALPHA_VANTAGE_API_KEY
 */

// ─── Shared types ─────────────────────────────────────────────────────────────

export type QueryType =
  | 'news'
  | 'factual'
  | 'realtime'
  | 'general'
  | 'weather'
  | 'finance'
  | 'sports';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full page content extracted by Firecrawl (may be empty) */
  fullContent?: string;
  source: string;
  publishedAt?: string;
  score: number;
}

export interface QueryAnalysisResult {
  originalQuery: string;
  cleanQuery: string;
  queryType: QueryType;
  isTimeSensitive: boolean;
  isFactual: boolean;
  extractedEntities: string[];
  searchTerms: string[];
}

export interface SearchPipelineResult {
  steps: {
    queryAnalysis: QueryAnalysisResult;
    sourcesSelected: string[];
    rawResultCount: number;
    mergedResultCount: number;
  };
  results: SearchResult[];
  abstract?: string;
  sourcesUsed: string[];
  searchTimeMs: number;
  queryType: QueryType;
}

// ─── In-memory result cache (TTL: 5 min) ─────────────────────────────────────

interface CacheEntry {
  result: SearchPipelineResult;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

function getCached(query: string): SearchPipelineResult | null {
  const entry = _cache.get(cacheKey(query));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(cacheKey(query)); return null; }
  return entry.result;
}

function setCached(query: string, result: SearchPipelineResult): void {
  // Don't cache time-sensitive queries
  if (result.queryType === 'realtime' || result.queryType === 'news') return;
  _cache.set(cacheKey(query), { result, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict oldest entries if cache grows too large
  if (_cache.size > 200) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

// ─── Step 1: Query Analysis ───────────────────────────────────────────────────

export function analyzeQuery(query: string): QueryAnalysisResult {
  const lower = query.toLowerCase().trim();

  const isNews     = /\b(news|headlines|breaking|latest|today|yesterday|this week|announcement|update|report|story|article|khabar|samachar|aatki)\b/i.test(lower);
  const isWeather  = /\b(weather|temperature|forecast|rain|humidity|wind|sunny|cloudy|snow|storm|climate|hot|cold|mausam|baarish|tapman)\b/i.test(lower);
  const isFinance  = /\b(stock|price|crypto|bitcoin|ethereum|market|nifty|sensex|nasdaq|dow|forex|usd|inr|eur|share|invest|trading|fund|ipo|dam|bhav|kimat|paise)\b/i.test(lower);
  const isSports   = /\b(cricket|football|soccer|ipl|match|score|live|tournament|league|team|player|goal|wicket|run|innings|series|khel|khiladi|jeet|haar)\b/i.test(lower);
  const isTimeSens = /\b(today|now|current|live|latest|recent|breaking|right now|this (week|month|year)|just|happening|ongoing|aaj|abhi|turant)\b/i.test(lower);
  const isFactual  = /\b(who|what|when|where|why|how|define|explain|meaning|history|invented|founded|capital|population|born|died|created|discovered|wrote|built|designed|located|based|kaun|kya|kab|kaha|kyu|kaise|kisne|matlab|arth)\b/i.test(lower)
    || /^(is |are |was |were |does |do |did |has |have |had |can |could |should |would )/i.test(lower);

  let queryType: QueryType = 'general';
  if (isWeather)       queryType = 'weather';
  else if (isFinance)  queryType = 'finance';
  else if (isSports)   queryType = 'sports';
  else if (isNews)     queryType = 'news';
  else if (isTimeSens) queryType = 'realtime';
  else if (isFactual)  queryType = 'factual';

  // Strip common question prefixes to get a cleaner search term
  const cleanQuery = query
    .replace(/^(search for|find|look up|tell me about|what is|what are|who is|who are|where is|where are|when did|when was|how does?|how do|how is|can you tell me|i want to know|please find|batao|dhundo|kya hai|kaun hai|kaha hai|kab hua)\s+/i, '')
    .replace(/\?+$/, '')
    .trim() || query;

  const extractedEntities =
    query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g)?.filter(e => e.length > 2) ?? [];

  const stopWords = new Set(['the','and','for','are','was','were','has','have','had','this','that','with','from','into','about','what','when','where','who','why','how','does','did','can','could','should','would','will','its','their','there','then','than','also','just','more','some','such','each','both','very','much','many','most','other','same','only','even','over','after','before','since','while','during','between','through','under','above','below','around','without','within','along','across','behind','beyond','against','toward','upon','onto','into','from','with','like','than','but','yet','nor','not','all','any','few','own','off','out','up','down','in','on','at','by','to','of','or','if','so','as','be','do','go','no','my','we','he','she','it','us','me','him','her','you','his','our','its','your','they','them','their','these','those','been','being','having','doing','going','coming','making','taking','getting','giving','saying','seeing','knowing','thinking','looking','using','finding','telling','asking','working','seeming','feeling','trying','leaving','calling','keeping','letting','beginning','showing','running','moving','living','standing','hearing','writing','reading','spending','playing','following','stopping','losing','cutting','setting','meeting','paying','sitting','speaking','lying','leading','walking','understanding','watching','turning','starting','carrying','bringing','waiting','holding','growing','opening','walking','winning','offering','remembering','loving','considering','appearing','buying','waiting','serving','dying','sending','expecting','building','staying','falling','reaching','killing','remaining','suggesting','raising','passing','selling','requiring','reporting','deciding','pulling']); 
  const searchTerms = cleanQuery
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));

  return {
    originalQuery: query,
    cleanQuery,
    queryType,
    isTimeSensitive: isTimeSens,
    isFactual,
    extractedEntities,
    searchTerms,
  };
}

// ─── Step 2: Source Selection ─────────────────────────────────────────────────

export function selectSources(analysis: QueryAnalysisResult): string[] {
  // Tavily is always first when configured — it handles every query type well
  const base: string[] = [];

  if (isConfigured('tavily')) base.push('tavily');

  switch (analysis.queryType) {
    case 'weather':
      base.push('open-meteo');
      break;
    case 'finance':
      if (isConfigured('coingecko'))      base.push('coingecko');
      if (isConfigured('alpha-vantage'))  base.push('alpha-vantage');
      break;
    case 'sports':
      if (isConfigured('cricapi'))        base.push('cricapi');
      break;
    case 'news':
      if (isConfigured('gnews'))          base.push('gnews');
      break;
    case 'factual':
      base.push('wikipedia');
      break;
    default:
      base.push('wikipedia');
  }

  // Firecrawl enriches the top Tavily URLs — add it when both are configured
  if (isConfigured('tavily') && isConfigured('firecrawl')) {
    base.push('firecrawl');
  }

  // DuckDuckGo is the last-resort free fallback
  if (!isConfigured('tavily')) base.push('duckduckgo');

  return [...new Set(base)].filter(isConfigured);
}

function isConfigured(source: string): boolean {
  switch (source) {
    case 'tavily':        return !!process.env.TAVILY_API_KEY;
    case 'firecrawl':     return !!process.env.FIRECRAWL_API_KEY;
    case 'gnews':         return !!process.env.GNEWS_API_KEY;
    case 'cricapi':       return !!process.env.CRICAPI_KEY;
    case 'alpha-vantage': return !!process.env.ALPHA_VANTAGE_API_KEY;
    // Always free
    case 'duckduckgo':    return true;
    case 'wikipedia':     return true;
    case 'open-meteo':    return true;
    case 'coingecko':     return true;
    default:              return false;
  }
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

async function withTimeout<T>(fn: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  } catch {
    return fallback;
  }
}

// ─── Step 3a: Tavily Search ───────────────────────────────────────────────────
// Tavily is purpose-built for AI agents — returns clean, ranked, real-time results.
// Docs: https://docs.tavily.com/docs/rest-api/api-reference

interface TavilyResult {
  title: string;
  url: string;
  content: string;       // snippet / summary
  raw_content?: string;  // full page content (when include_raw_content: true)
  score: number;         // Tavily's own relevance score 0-1
  published_date?: string;
}

interface TavilyResponse {
  query: string;
  answer?: string;       // Tavily's own AI answer (when include_answer: true)
  results: TavilyResult[];
}

async function fetchTavily(
  query: string,
  queryType: QueryType
): Promise<{ results: SearchResult[]; abstract?: string }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { results: [] };

  // Tune search depth per query type
  const searchDepth = (queryType === 'realtime' || queryType === 'news') ? 'advanced' : 'basic';
  const topic       = (queryType === 'news') ? 'news' : 'general';

  const body = {
    api_key: key,
    query,
    search_depth: searchDepth,
    topic,
    include_answer: true,          // get Tavily's own AI answer as abstract
    include_raw_content: false,    // Firecrawl handles full content extraction
    max_results: 8,
    include_domains: [],
    exclude_domains: [],
  };

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.warn(`[Tavily] HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    return { results: [] };
  }

  const data = await res.json() as TavilyResponse;

  const results: SearchResult[] = (data.results ?? []).map(r => ({
    title:       r.title ?? '',
    url:         r.url ?? '',
    snippet:     r.content ?? '',
    source:      'tavily',
    publishedAt: r.published_date ?? undefined,
    score:       r.score ?? 0.8,
  }));

  return {
    results,
    abstract: data.answer ?? undefined,
  };
}

// ─── Step 3b: Firecrawl Deep Extraction ──────────────────────────────────────
// Firecrawl scrapes and cleans full page content from URLs.
// We feed it the top Tavily URLs to get richer context for AI synthesis.
// Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    content?: string;
    metadata?: { title?: string; description?: string };
  };
}

async function firecrawlScrapeUrl(url: string): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return '';

  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 8000,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return '';

  const data = await res.json() as FirecrawlScrapeResponse;
  const raw = data.data?.markdown ?? data.data?.content ?? '';
  // Trim to 1500 chars — enough context without blowing the AI prompt
  return raw.slice(0, 1500).trim();
}

/**
 * Enrich the top N Tavily results with full page content via Firecrawl.
 * Runs scrapes in parallel (max 2 URLs to stay within rate limits + keep latency low).
 */
async function enrichWithFirecrawl(results: SearchResult[]): Promise<SearchResult[]> {
  if (!isConfigured('firecrawl') || results.length === 0) return results;

  const TOP_N = 2; // scrape only top 2 — faster, still meaningful
  const toEnrich = results.slice(0, TOP_N);
  const rest     = results.slice(TOP_N);

  console.log(`[Firecrawl] Enriching ${toEnrich.length} URLs...`);

  const enriched = await Promise.all(
    toEnrich.map(async r => {
      const fullContent = await withTimeout(
        () => firecrawlScrapeUrl(r.url),
        7000,
        ''
      );
      if (fullContent) {
        console.log(`[Firecrawl] ✓ ${r.url.slice(0, 60)}... (${fullContent.length} chars)`);
      }
      return { ...r, fullContent: fullContent || undefined };
    })
  );

  return [...enriched, ...rest];
}

// ─── Step 3c: DuckDuckGo (free fallback) ─────────────────────────────────────

async function fetchDuckDuckGo(
  query: string
): Promise<{ results: SearchResult[]; abstract?: string }> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { results: [] };

  const data = await res.json() as any;
  const results: SearchResult[] = [];

  // Direct results (higher quality)
  for (const r of (data.Results ?? [])) {
    if (r.FirstURL && r.Text && r.Text.length > 20) {
      results.push({
        title:   r.Text.split(' - ')[0]?.trim() ?? r.Text,
        url:     r.FirstURL,
        snippet: r.Text.replace(/<[^>]*>/g, '').trim(),
        source:  'duckduckgo',
        score:   0.75,
      });
    }
  }

  // RelatedTopics — only include leaf nodes (not category headers)
  // Category headers have no snippet text or are very short
  for (const t of (data.RelatedTopics ?? [])) {
    if (t.FirstURL && t.Text && t.Text.length > 40 && !t.Topics) {
      results.push({
        title:   t.Text.split(' - ')[0]?.trim() ?? t.Text,
        url:     t.FirstURL,
        snippet: t.Text.replace(/<[^>]*>/g, '').trim(),
        source:  'duckduckgo',
        score:   0.50,
      });
    }
  }

  const abstract = data.Abstract?.trim()
    ? `${data.Abstract}${data.AbstractSource ? ` (${data.AbstractSource})` : ''}`
    : undefined;

  return { results: results.slice(0, 8), abstract };
}

// ─── Step 3d: Wikipedia ───────────────────────────────────────────────────────

async function fetchWikipedia(
  query: string
): Promise<{ results: SearchResult[]; abstract?: string }> {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`;
  const res = await fetch(searchUrl);
  if (!res.ok) return { results: [] };

  const data = await res.json() as any;
  const hits  = data.query?.search ?? [];

  const results: SearchResult[] = hits.map((h: any, i: number) => ({
    title:   h.title,
    url:     `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
    snippet: h.snippet?.replace(/<[^>]*>/g, '').trim() ?? '',
    source:  'wikipedia',
    score:   0.80 - i * 0.05,
  }));

  let abstract: string | undefined;
  if (hits[0]?.title) {
    try {
      const introRes = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hits[0].title)}`
      );
      if (introRes.ok) {
        const intro = await introRes.json() as any;
        abstract = intro.extract?.slice(0, 400);
      }
    } catch { /* ignore */ }
  }

  return { results, abstract };
}

// ─── Step 3e: GNews ───────────────────────────────────────────────────────────

async function fetchGNews(query: string): Promise<SearchResult[]> {
  const key = process.env.GNEWS_API_KEY;
  if (!key) return [];

  const res = await fetch(
    `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=6&apikey=${encodeURIComponent(key)}`
  );
  if (!res.ok) return [];

  const data = await res.json() as any;
  return (data.articles ?? []).map((a: any, i: number) => ({
    title:       a.title ?? '',
    url:         a.url ?? '',
    snippet:     a.description ?? '',
    source:      'gnews',
    publishedAt: a.publishedAt ?? undefined,
    score:       0.90 - i * 0.05,
  }));
}

// ─── Step 3f: Domain-specific tools (weather / finance / sports) ──────────────

async function fetchOpenMeteo(query: string): Promise<SearchResult[]> {
  const inMatch = query.match(/\bin\s+([a-zA-Z\s,.-]+)$/i);
  const location = (inMatch?.[1] ?? query).trim().slice(0, 80);

  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
    );
    if (!geoRes.ok) return [];
    const geo = await geoRes.json() as any;
    const place = geo.results?.[0];
    if (!place) return [];

    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m,weather_code&timezone=auto`
    );
    if (!wxRes.ok) return [];
    const wx = await wxRes.json() as any;
    const c = wx.current;
    if (!c) return [];

    return [{
      title:   `Weather in ${place.name}${place.country ? `, ${place.country}` : ''}`,
      url:     `https://open-meteo.com`,
      snippet: `${c.temperature_2m ?? 'N/A'}°C, wind ${c.wind_speed_10m ?? 'N/A'} km/h (code ${c.weather_code ?? 'N/A'})`,
      source:  'open-meteo',
      score:   1.0,
    }];
  } catch {
    return [];
  }
}

async function fetchCoinGecko(query: string): Promise<SearchResult[]> {
  const lower = query.toLowerCase();
  const map: Record<string, string> = {
    bitcoin: 'bitcoin', btc: 'bitcoin',
    ethereum: 'ethereum', eth: 'ethereum',
    solana: 'solana', sol: 'solana',
    dogecoin: 'dogecoin', doge: 'dogecoin',
  };
  const id = Object.entries(map).find(([k]) => lower.includes(k))?.[1];
  if (!id) return [];

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const q = data[id];
    if (!q) return [];
    return [{
      title:   `${id.toUpperCase()} Price`,
      url:     `https://coingecko.com/en/coins/${id}`,
      snippet: `$${q.usd ?? 'N/A'} USD (24h change: ${q.usd_24h_change?.toFixed(2) ?? 'N/A'}%)`,
      source:  'coingecko',
      score:   1.0,
    }];
  } catch {
    return [];
  }
}

async function fetchAlphaVantage(query: string): Promise<SearchResult[]> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return [];
  const sym = query.toUpperCase().match(/\b[A-Z]{1,5}\b/)?.[0];
  if (!sym) return [];

  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${key}`
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const q = data['Global Quote'] ?? {};
    if (!q['05. price']) return [];
    return [{
      title:   `${sym} Stock Price`,
      url:     `https://finance.yahoo.com/quote/${sym}`,
      snippet: `$${q['05. price']} (change: ${q['10. change percent'] ?? 'N/A'})`,
      source:  'alpha-vantage',
      score:   1.0,
    }];
  } catch {
    return [];
  }
}

async function fetchCricAPI(query: string): Promise<SearchResult[]> {
  const key = process.env.CRICAPI_KEY;
  if (!key) return [];

  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(key)}&offset=0`
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.data ?? []).slice(0, 5).map((m: any) => ({
      title:   m.name ?? 'Cricket Match',
      url:     'https://cricapi.com',
      snippet: `${m.status ?? 'Status unavailable'} — ${m.venue ?? 'Unknown venue'}`,
      source:  'cricapi',
      score:   0.95,
    }));
  } catch {
    return [];
  }
}

// ─── Step 4: Merge & Rank ─────────────────────────────────────────────────────

function mergeAndRank(all: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out:  SearchResult[] = [];

  // Sort by score desc — Tavily results naturally float to top
  all.sort((a, b) => b.score - a.score);

  for (const r of all) {
    if (!r.title || !r.url) continue;
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= 10) break;
  }

  return out;
}

// ─── Main Pipeline (Steps 1-4) ────────────────────────────────────────────────

export async function runSearchPipeline(query: string): Promise<SearchPipelineResult> {
  const t0 = Date.now();

  // ── Cache check ───────────────────────────────────────────────────────────
  const cached = getCached(query);
  if (cached) {
    console.log(`[Search] Cache hit for "${query.slice(0, 60)}"`);
    return { ...cached, searchTimeMs: Date.now() - t0 };
  }

  // ── Step 1 ────────────────────────────────────────────────────────────────
  const analysis = analyzeQuery(query);
  console.log(`[Search] Step 1 — type: ${analysis.queryType}  clean: "${analysis.cleanQuery}"`);

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const sources = selectSources(analysis);
  // Guarantee at least one free source
  if (sources.length === 0) sources.push('duckduckgo');
  console.log(`[Search] Step 2 — sources: ${sources.join(', ')}`);

  // ── Step 3: Parallel fetch (excluding Firecrawl — it runs after) ──────────
  type FetchOut = { results: SearchResult[]; abstract?: string };
  const empty: FetchOut = { results: [] };

  const fetchJobs: Promise<FetchOut>[] = [];

  if (sources.includes('tavily')) {
    fetchJobs.push(
      withTimeout(() => fetchTavily(analysis.cleanQuery, analysis.queryType), 8000, empty)
    );
  }
  if (sources.includes('gnews')) {
    fetchJobs.push(
      withTimeout(() => fetchGNews(analysis.cleanQuery).then(r => ({ results: r })), 6000, empty)
    );
  }
  if (sources.includes('wikipedia')) {
    fetchJobs.push(
      withTimeout(() => fetchWikipedia(analysis.cleanQuery), 6000, empty)
    );
  }
  if (sources.includes('duckduckgo')) {
    fetchJobs.push(
      withTimeout(() => fetchDuckDuckGo(analysis.cleanQuery), 6000, empty)
    );
  }
  if (sources.includes('open-meteo')) {
    fetchJobs.push(
      withTimeout(() => fetchOpenMeteo(analysis.cleanQuery).then(r => ({ results: r })), 6000, empty)
    );
  }
  if (sources.includes('coingecko')) {
    fetchJobs.push(
      withTimeout(() => fetchCoinGecko(analysis.cleanQuery).then(r => ({ results: r })), 6000, empty)
    );
  }
  if (sources.includes('alpha-vantage')) {
    fetchJobs.push(
      withTimeout(() => fetchAlphaVantage(analysis.cleanQuery).then(r => ({ results: r })), 6000, empty)
    );
  }
  if (sources.includes('cricapi')) {
    fetchJobs.push(
      withTimeout(() => fetchCricAPI(analysis.cleanQuery).then(r => ({ results: r })), 6000, empty)
    );
  }

  const fetched = await Promise.all(fetchJobs);
  console.log(`[Search] Step 3 — fetched from ${fetched.length} source(s)`);

  const rawResults: SearchResult[] = fetched.flatMap(f => f.results);
  const abstract = fetched.find(f => f.abstract)?.abstract;
  const rawCount = rawResults.length;

  // ── Step 4: Merge & rank ──────────────────────────────────────────────────
  let merged = mergeAndRank(rawResults);

  // ── Firecrawl enrichment (runs after merge, on top results) ───────────────
  // Budget: 12s total. If it times out, we return un-enriched results — no blocking.
  if (sources.includes('firecrawl') && merged.length > 0) {
    console.log(`[Search] Step 3b — Firecrawl enrichment on top ${Math.min(2, merged.length)} URLs`);
    merged = await withTimeout(
      () => enrichWithFirecrawl(merged),
      12000,
      merged
    );
  }

  const sourcesUsed = [...new Set(merged.map(r => r.source))];
  console.log(`[Search] Step 4 — merged: ${rawCount} → ${merged.length} unique  sources: ${sourcesUsed.join(', ')}`);

  const result: SearchPipelineResult = {
    steps: {
      queryAnalysis:     analysis,
      sourcesSelected:   sources,
      rawResultCount:    rawCount,
      mergedResultCount: merged.length,
    },
    results:     merged,
    abstract,
    sourcesUsed,
    searchTimeMs: Date.now() - t0,
    queryType:   analysis.queryType,
  };

  setCached(query, result);
  return result;
}
