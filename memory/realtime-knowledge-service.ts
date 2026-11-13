/**
 * Realtime Knowledge Service
 * ════════════════════════════════════════════════════════════════════════════
 * Provides SOHAM with live awareness of:
 *   - Current date, time, day, timezone
 *   - Live news and web results from the shared multi-provider search engine
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
import { runSearchPipeline } from '../tools/search-engine';

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

/**
 * Prepend the current date/time as the very first line of any system prompt.
 * Use this in every flow and route that calls an AI model.
 *
 * Example output:
 *   TODAY: Saturday, 03 May 2026 — 09:15 UTC
 *
 *   You are an expert fact-checker...
 */
export function withDateTime(systemPrompt: string): string {
  const dt = getCurrentDateTimeContext();
  const line = `TODAY: ${dt.dayOfWeek}, ${dt.date} — ${dt.time}`;
  return `${line}\n\n${systemPrompt}`;
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
  // Keep content short — Upstash has a ~40KB per-request limit and the
  // embedding vector alone is ~24KB, so data must stay under ~800 chars.
  const text = `[${result.type.toUpperCase()} — ${result.fetchedAt}] ${result.content.slice(0, 600)}`;
  const vector = await generateEmbedding(text.slice(0, 512));

  try {
    await upstashPost('/upsert', {
      vectors: [{
        id,
        vector,
        metadata: {
          namespace: 'realworld',
          type: result.type,
          source: result.source,
          query: result.query.slice(0, 80),
          fetched_at: result.fetchedAt,
          expires_at: expiresAt,
          ttl_hours: result.ttlHours,
          // Store a short preview in metadata instead of full data field
          preview: text.slice(0, 300),
        },
        // data field omitted — use metadata.preview for retrieval
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
    .map((m: any) => {
      // Support both old `data` field and new `metadata.preview`
      const text = typeof m.data === 'string' && m.data.length > 0
        ? m.data
        : typeof m.metadata?.preview === 'string'
        ? m.metadata.preview
        : '';
      return text;
    })
    .filter(t => t.length > 0)
    .slice(0, topK);
}

// ─── Live news fetch ──────────────────────────────────────────────────────────

async function fetchLiveNews(query: string): Promise<LiveDataResult | null> {
  const result = await runSearchPipeline(query);
  if (result.results.length === 0) return null;
  const content = [
    result.abstract ? `Search summary: ${result.abstract}` : '',
    ...result.results.slice(0, 5).map((article, index) =>
      `${index + 1}. ${article.title}${article.publishedAt ? ` (${article.publishedAt})` : ''}` +
      `${article.snippet ? ` — ${article.snippet}` : ''}${article.url ? `\n   Source: ${article.url}` : ''}`
    ),
  ].filter(Boolean).join('\n');
  return {
    type: 'news', query, content,
    source: result.sourcesUsed.join(', ') || 'search-engine',
    fetchedAt: new Date().toISOString(), ttlHours: 1,
  };
}

// ─── Live web search fetch ────────────────────────────────────────────────────

async function fetchLiveWebSearch(query: string): Promise<LiveDataResult | null> {
  const result = await runSearchPipeline(query);
  if (result.results.length === 0) return null;
  const content = [
    result.abstract ? `Search summary: ${result.abstract}` : '',
    ...result.results.slice(0, 5).map((item, index) =>
      `${index + 1}. ${item.title}${item.snippet ? ` — ${item.snippet}` : ''}` +
      `${item.url ? `\n   Source: ${item.url}` : ''}`
    ),
  ].filter(Boolean).join('\n');
  return {
    type: 'web', query, content,
    source: result.sourcesUsed.join(', ') || 'search-engine',
    fetchedAt: new Date().toISOString(), ttlHours: 3,
  };
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
