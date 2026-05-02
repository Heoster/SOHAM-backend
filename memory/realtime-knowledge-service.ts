/**
 * Realtime Knowledge Service
 * ════════════════════════════════════════════════════════════════════════════
 * Provides SOHAM with live awareness of:
 *   - Current date, time, day, timezone
 *   - Live news headlines (GNews → Tavily → DuckDuckGo fallback)
 *   - Live weather for detected locations
 *   - Live web search results
 *
 * Results are stored in Upstash Vector as REAL_WORLD chunks so they:
 *   1. Enrich the current response immediately
 *   2. Are retrievable by future semantically similar queries (RAG)
 *   3. Expire after a configurable TTL (news: 1h, weather: 30min, facts: 24h)
 *
 * This is the "self-organising" layer — SOHAM learns from every live query
 * and reuses that knowledge without hitting external APIs again.
 */

import { randomUUID } from 'crypto';
import { generateEmbedding } from './enhanced-rag';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RealtimeContext {
  datetime: DateTimeContext;
  liveData?: LiveDataResult[];
}

export interface DateTimeContext {
  iso: string;           // 2026-05-02T08:30:00.000Z
  utc: string;           // Saturday, 02 May 2026, 08:30 UTC
  local?: string;        // localised if timezone known
  dayOfWeek: string;
  date: string;          // 02 May 2026
  time: string;          // 08:30 UTC
  year: number;
  month: string;
  timestamp: number;
}

export interface LiveDataResult {
  type: 'news' | 'weather' | 'finance' | 'sports' | 'web';
  query: string;
  content: string;
  source: string;
  fetchedAt: string;
  ttlHours: number;      // how long this is valid
}

// ─── Date/Time ────────────────────────────────────────────────────────────────

export function getCurrentDateTimeContext(timezone?: string): DateTimeContext {
  const now = new Date();
  const iso = now.toISOString();
  const timestamp = now.getTime();

  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const dayOfWeek = days[now.getUTCDay()];
  const date      = `${String(now.getUTCDate()).padStart(2,'0')} ${months[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const time      = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;
  const utc       = `${dayOfWeek}, ${date}, ${time}`;
  const year      = now.getUTCFullYear();
  const month     = months[now.getUTCMonth()];

  let local: string | undefined;
  if (timezone) {
    try {
      local = now.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });
    } catch { /* ignore invalid timezone */ }
  }

  return { iso, utc, local, dayOfWeek, date, time, year, month, timestamp };
}

export function buildDateTimePromptLine(ctx: DateTimeContext): string {
  return `Current date and time: ${ctx.utc}${ctx.local ? ` (${ctx.local})` : ''}`;
}

// ─── Upstash helpers ──────────────────────────────────────────────────────────

function getUpstash() {
  return {
    url: (process.env.UPSTASH_VECTOR_REST_URL ?? process.env.UPSTASH_VECTOR_URL ?? '').replace(/\/$/, ''),
    token: process.env.UPSTASH_VECTOR_REST_TOKEN ?? process.env.UPSTASH_VECTOR_TOKEN ?? '',
  };
}

function isUpstashReady(): boolean {
  const { url, token } = getUpstash();
  return Boolean(url && token);
}

async function upstashPost(path: string, body: unknown, timeoutMs = 6000): Promise<any> {
  const { url, token } = getUpstash();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Upstash ${path} ${res.status}`);
  return res.json();
}

// ─── Store live data in Upstash ───────────────────────────────────────────────

/**
 * Store a live data result in Upstash Vector under the `realworld:` namespace.
 * Tagged with `expires_at` so stale entries can be filtered out.
 */
export async function storeRealtimeChunk(result: LiveDataResult): Promise<void> {
  if (!isUpstashReady() || result.content.trim().length < 20) return;

  const id = `realworld:${result.type}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + result.ttlHours * 3_600_000).toISOString();
  const text = `[${result.type.toUpperCase()} — ${result.fetchedAt}] ${result.content}`;
  const vector = await generateEmbedding(text.slice(0, 1500));

  try {
    await upstashPost('/upsert', {
      vectors: [{
        id,
        vector,
        metadata: {
          namespace: 'realworld',
          type: result.type,
          source: result.source,
          query: result.query.slice(0, 100),
          fetched_at: result.fetchedAt,
          expires_at: expiresAt,
          ttl_hours: result.ttlHours,
        },
        data: text.slice(0, 1500),
      }],
    });
  } catch (err) {
    console.warn('[Realtime] Failed to store chunk:', err);
  }
}

/**
 * Query Upstash for non-expired realworld chunks matching the query.
 */
export async function queryRealtimeChunks(queryText: string, topK = 3): Promise<string[]> {
  if (!isUpstashReady()) return [];

  const vector = await generateEmbedding(queryText.slice(0, 1500));
  const now = new Date().toISOString();

  let payload: any;
  try {
    payload = await upstashPost('/query', {
      vector,
      topK: topK * 3,
      includeMetadata: true,
      includeData: true,
      filter: `namespace = 'realworld'`,
    });
  } catch {
    try {
      payload = await upstashPost('/query', {
        vector,
        topK: topK * 5,
        includeMetadata: true,
        includeData: true,
      });
    } catch {
      return [];
    }
  }

  const matches: any[] = payload?.result ?? payload?.matches ?? [];

  return matches
    .filter((m: any) => {
      const ns = m.metadata?.namespace as string | undefined;
      const id = String(m.id);
      if (ns !== 'realworld' && !id.startsWith('realworld:')) return false;
      // Filter expired entries
      const expiresAt = m.metadata?.expires_at as string | undefined;
      if (expiresAt && expiresAt < now) return false;
      return (m.score ?? 0) >= 0.40;
    })
    .map((m: any) => typeof m.data === 'string' ? m.data : '')
    .filter(t => t.length > 0)
    .slice(0, topK);
}

// ─── Live news fetch ──────────────────────────────────────────────────────────

async function fetchLiveNews(query: string): Promise<LiveDataResult | null> {
  const gnewsKey = process.env.GNEWS_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  const fetchedAt = new Date().toISOString();

  // Try GNews first
  if (gnewsKey) {
    try {
      const res = await fetch(
        `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=5&apikey=${gnewsKey}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) {
        const data = await res.json() as any;
        const articles = data.articles ?? [];
        if (articles.length > 0) {
          const content = articles
            .slice(0, 5)
            .map((a: any, i: number) => `${i+1}. ${a.title} (${a.source?.name ?? 'Unknown'}, ${a.publishedAt ?? 'N/A'})`)
            .join('\n');
          return { type: 'news', query, content, source: 'gnews', fetchedAt, ttlHours: 1 };
        }
      }
    } catch { /* fall through */ }
  }

  // Try Tavily news topic
  if (tavilyKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query, topic: 'news', max_results: 5, include_answer: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const results = data.results ?? [];
        if (results.length > 0) {
          const content = (data.answer ? `Summary: ${data.answer}\n\n` : '') +
            results.slice(0, 5).map((r: any, i: number) => `${i+1}. ${r.title} — ${r.content?.slice(0,120)}`).join('\n');
          return { type: 'news', query, content, source: 'tavily', fetchedAt, ttlHours: 1 };
        }
      }
    } catch { /* fall through */ }
  }

  // DuckDuckGo fallback
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query + ' news')}&format=json&no_html=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json() as any;
      const topics = (data.RelatedTopics ?? []).filter((t: any) => t.Text && t.Text.length > 30).slice(0, 5);
      if (topics.length > 0) {
        const content = topics.map((t: any, i: number) => `${i+1}. ${t.Text}`).join('\n');
        return { type: 'news', query, content, source: 'duckduckgo', fetchedAt, ttlHours: 0.5 };
      }
    }
  } catch { /* ignore */ }

  return null;
}

// ─── Live web search fetch ────────────────────────────────────────────────────

async function fetchLiveWebSearch(query: string): Promise<LiveDataResult | null> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const youKey    = process.env.YOU_API_KEY;
  const fetchedAt = new Date().toISOString();

  // Try You.com API
  if (youKey) {
    try {
      const res = await fetch(
        `https://api.ydc-index.io/search?query=${encodeURIComponent(query)}&num_web_results=5`,
        {
          headers: { 'X-API-Key': youKey },
          signal: AbortSignal.timeout(7000),
        }
      );
      if (res.ok) {
        const data = await res.json() as any;
        const hits = data.hits ?? [];
        if (hits.length > 0) {
          const content = hits.slice(0, 5)
            .map((h: any, i: number) => `${i+1}. ${h.title} — ${(h.snippets ?? [h.description ?? '']).join(' ').slice(0, 200)}`)
            .join('\n');
          return { type: 'web', query, content, source: 'you.com', fetchedAt, ttlHours: 6 };
        }
      }
    } catch { /* fall through */ }
  }

  // Try Tavily
  if (tavilyKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query, search_depth: 'basic', max_results: 5, include_answer: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const results = data.results ?? [];
        if (results.length > 0) {
          const content = (data.answer ? `Answer: ${data.answer}\n\n` : '') +
            results.slice(0, 5).map((r: any, i: number) => `${i+1}. ${r.title} — ${r.content?.slice(0, 150)}`).join('\n');
          return { type: 'web', query, content, source: 'tavily', fetchedAt, ttlHours: 6 };
        }
      }
    } catch { /* fall through */ }
  }

  // DuckDuckGo fallback
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json() as any;
      const abstract = data.Abstract?.trim();
      const topics = (data.RelatedTopics ?? []).filter((t: any) => t.Text?.length > 30).slice(0, 4);
      if (abstract || topics.length > 0) {
        const content = [
          abstract ? `Summary: ${abstract}` : '',
          ...topics.map((t: any, i: number) => `${i+1}. ${t.Text}`),
        ].filter(Boolean).join('\n');
        return { type: 'web', query, content, source: 'duckduckgo', fetchedAt, ttlHours: 3 };
      }
    }
  } catch { /* ignore */ }

  return null;
}

// ─── Main: get realtime context for a query ───────────────────────────────────

/**
 * Called by the orchestrator for every request.
 * Returns:
 *   1. Current date/time context (always)
 *   2. Cached realworld RAG chunks (if any match the query)
 *   3. Fresh live data (if query is time-sensitive and no cache hit)
 *
 * Fresh results are stored back to Upstash for future reuse.
 */
export async function getRealtimeContext(
  query: string,
  queryType: 'news' | 'web' | 'weather' | 'finance' | 'sports' | 'general' = 'general'
): Promise<RealtimeContext> {
  const datetime = getCurrentDateTimeContext();

  // Always try cached realworld chunks first
  const cached = await queryRealtimeChunks(query, 3).catch(() => [] as string[]);

  // If we have good cached results, skip live fetch
  if (cached.length >= 2) {
    return {
      datetime,
      liveData: cached.map(c => ({
        type: queryType === 'news' ? 'news' : 'web',
        query,
        content: c,
        source: 'upstash-cache',
        fetchedAt: new Date().toISOString(),
        ttlHours: 1,
      })),
    };
  }

  // Fetch live data based on query type
  const liveData: LiveDataResult[] = [];

  if (queryType === 'news') {
    const news = await fetchLiveNews(query).catch(() => null);
    if (news) {
      liveData.push(news);
      storeRealtimeChunk(news).catch(() => {}); // async store, non-blocking
    }
  } else if (queryType !== 'general') {
    // For weather/finance/sports, the tool system handles it — just return datetime
  } else {
    // General query — try web search
    const web = await fetchLiveWebSearch(query).catch(() => null);
    if (web) {
      liveData.push(web);
      storeRealtimeChunk(web).catch(() => {}); // async store, non-blocking
    }
  }

  // Merge cached + fresh
  const allLive: LiveDataResult[] = [
    ...cached.map(c => ({
      type: 'web' as const,
      query,
      content: c,
      source: 'upstash-cache',
      fetchedAt: new Date().toISOString(),
      ttlHours: 1,
    })),
    ...liveData,
  ];

  return { datetime, liveData: allLive.length > 0 ? allLive : undefined };
}
