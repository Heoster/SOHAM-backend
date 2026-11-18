/**
 * SOHAM YouTube Play
 * ════════════════════════════════════════════════════════════════════════════
 * "Play <query>" for the chat page / voice flow.
 *
 * Flow:
 *   1. Take the user's request ("play lofi hip hop radio") and inject it into
 *      a YouTube search URL:
 *        https://www.youtube.com/results?search_query=<encoded>
 *   2. Fetch that search page through a reader/scraper proxy:
 *        PRIMARY   → Jina Reader   https://r.jina.ai/http://www.youtube.com/results?search_query=...
 *        FALLBACK  → Firecrawl     https://api.firecrawl.dev/v1/scrape
 *   3. Parse the returned markdown for the first real video result
 *      (https://www.youtube.com/watch?v=<11-char id>). Playlists, channels,
 *      and "(channel)" links are skipped. Shorts are accepted only if no
 *      regular watch URL is found.
 *   4. Return the result to the caller together with BOTH playback URLs:
 *        watchUrl → open in a new tab (fallback when embed is blocked)
 *        embedUrl → iframe inside the chat page (preferred)
 *      Iframes cannot report embed-disallowed errors cross-origin, so the
 *      client MUST offer a "Watch on YouTube" tab fallback next to the player.
 *
 * Env vars (both optional; Jina works key-less at a low, shared rate limit):
 *   JINA_API_KEY        https://jina.ai          (raises r.jina.ai limits)
 *   FIRECRAWL_API_KEY   https://www.firecrawl.dev (used when Jina fails)
 *
 * Design trade-offs and failure modes are documented in
 * docs/YOUTUBE_PLAY_TOOL.md — read it before changing the parsing logic.
 */

import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface YouTubeVideoCandidate {
  videoId: string;
  title: string;
  watchUrl: string;
  embedUrl: string;
  thumbnailUrl: string;
  channel?: string;
}

export interface YouTubePlayResult {
  ok: boolean;
  /** Cleaned query that was actually searched */
  query: string;
  /** The YouTube search URL the query was injected into */
  searchUrl: string;
  searchTimeMs: number;
  /** Which fetcher produced the winning result (absent on failure) */
  source?: 'jina' | 'firecrawl' | 'cache';
  /** Chosen (first) video, present when ok === true */
  videoId?: string;
  title?: string;
  channel?: string;
  watchUrl?: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  /** Up to 5 de-duplicated candidates, strongest first (frontend can offer "next") */
  candidates: YouTubeVideoCandidate[];
  error?: string;
}

// ─── Small in-memory cache (TTL: 5 min) + in-flight dedupe ────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;

interface CacheEntry {
  result: YouTubePlayResult;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();
const _inFlight = new Map<string, Promise<YouTubePlayResult>>();

function normalizeKey(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

function getCached(key: string): YouTubePlayResult | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return { ...entry.result, source: 'cache', searchTimeMs: 0 };
}

function setCached(key: string, result: YouTubePlayResult): void {
  if (!result.ok) return; // don't cache failures
  _cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  if (_cache.size > CACHE_MAX) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

// ─── Query sanitizing / command extraction ────────────────────────────────────

/** Strip control chars, collapse whitespace, cap length. Keeps the query search-friendly. */
export function sanitizePlayQuery(query: string): string {
  return query
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/**
 * Extract the "what to play" part from a chat/voice message.
 * Handles: "play X", "watch X", "put on X", "stream X", "/play X",
 *          "soham play X", "can you play X on youtube".
 * Returns null when the message is not a play command, or when it looks like a
 * how-to / sports request (those belong to web search / sports tools).
 */
export function extractPlayQuery(message: string): string | null {
  let m = message.trim();
  if (!m) return null;

  // Slash command: /play, /watch, /youtube, /yt, /video
  const slash = m.match(/^\/(?:play|watch|youtube|yt|video|play_video)\s+(.+)$/i);
  if (slash) m = slash[1];
  else {
    // Optional speaker + politeness prefix, then a leading media verb
    const vm = m.match(
      /^(?:(?:hey\s+)?soham[,!]?\s*)?(?:(?:please|pls)\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:play|watch|put on|stream|open)\s+(.{2,})$/i,
    );
    if (!vm) return null;
    m = vm[1];
  }

  m = m
    .replace(/^(?:the|a|some|this|that|me)\s+/i, '')
    .replace(/\s+(?:on|in|from|via)\s+(?:youtube|yt|youtube\.com)\b\.?\s*$/i, ' ') // trailing "on youtube"
    .replace(/\s+/g, ' ')
    .trim();

  if (m.length < 2) return null;
  // Not a playback request: tutorial / how-to phrasing
  if (/^(?:how|ways|learn|tutorial|lessons?|tips)\b/i.test(m)) return null;
  // Sports intent — let the sports tool handle it
  if (/\b(?:cricket|ipl|football|soccer|basketball|tennis|hockey|baseball|score|match|matches|tournament|league|grand slam|world cup|odi|t20)\b/i.test(m)) return null;

  return sanitizePlayQuery(m);
}

// ─── URL building ─────────────────────────────────────────────────────────────

export function buildYouTubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

// ─── Markdown parsing ─────────────────────────────────────────────────────────

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MARKDOWN_LINK_RE = /\[([^\]]{0,300})\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/g;
const BARE_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s"'<>\)\]]*|youtu\.be\/[A-Za-z0-9_-]{11})/g;

/** Extract an 11-char video id from a YouTube watch/shorts/youtu.be URL. */
export function extractVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^(www\.|m\.)/, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
      return VIDEO_ID_RE.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = url.searchParams.get('v');
      if (v && VIDEO_ID_RE.test(v)) return v;
      const shorts = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\b/);
      if (shorts && VIDEO_ID_RE.test(shorts[1])) return shorts[1];
    }
    return null;
  } catch {
    return null;
  }
}

function isShortsUrl(rawUrl: string): boolean {
  return /youtube\.com\/shorts\//i.test(rawUrl);
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function cleanTitle(raw: string): string {
  let t = decodeBasicEntities(raw);
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');        // strip images
  t = t.replace(/[*_`#]/g, ' ');                      // strip md emphasis
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*[-–|]\s*YouTube\s*$/i, '').trim(); // trailing "- YouTube"
  return t.slice(0, 200);
}

interface RawHit {
  id: string;
  title: string;
  url: string;
  index: number;
  markdown: boolean;
}

/**
 * Parse the markdown/text we get back from Jina Reader or Firecrawl and return
 * de-duplicated video candidates in page order (strongest first).
 * Regular-watch hits win; Shorts are only used as a last resort.
 */
export function parseYouTubeSearchMarkdown(markdown: string): YouTubeVideoCandidate[] {
  const hits: RawHit[] = [];
  const seenLinks = new Set<string>();

  // 1) Markdown links [title](url)
  for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
    const [, text, url] = match;
    const id = extractVideoId(url);
    if (!id || seenLinks.has(url)) continue;
    seenLinks.add(url);
    hits.push({
      id,
      title: cleanTitle(text) || `YouTube video ${id}`,
      url,
      index: match.index ?? 0,
      markdown: true,
    });
  }

  // 2) Bare URLs not already captured via markdown link syntax
  for (const match of markdown.matchAll(BARE_URL_RE)) {
    const url = match[0];
    if (seenLinks.has(url)) continue;
    const id = extractVideoId(url);
    if (!id) continue;
    seenLinks.add(url);
    hits.push({
      id,
      title: `YouTube video ${id}`, // no anchor text available
      url,
      index: match.index ?? 0,
      markdown: false,
    });
  }

  if (hits.length === 0) return [];

  // Prefer non-Short watch URLs; fall back to Shorts only if nothing else matched
  const watchHits = hits.filter(h => !isShortsUrl(h.url));
  const pool = watchHits.length > 0 ? watchHits : hits;

  // Page order is the ranking; dedupe by video id, keep first occurrence
  pool.sort((a, b) => a.index - b.index);
  const byId = new Map<string, RawHit>();
  for (const hit of pool) {
    if (!byId.has(hit.id)) byId.set(hit.id, hit);
  }

  // Best-effort channel extraction: look for a @handle /channel/ link within
  // the few lines following each hit's link in the markdown.
  const lines = markdown.split('\n');
  const channels = extractChannelsNearHits(lines);

  return [...byId.values()].slice(0, 5).map(hit => ({
    videoId: hit.id,
    title: hit.title,
    watchUrl: `https://www.youtube.com/watch?v=${hit.id}`,
    embedUrl: `https://www.youtube.com/embed/${hit.id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${hit.id}/hqdefault.jpg`,
    channel: channels.get(hit.id),
  }));
}

function extractChannelsNearHits(lines: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const videoLineIndexes: Array<{ id: string; line: number }> = [];

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/watch\?[^\s)>]*v=([A-Za-z0-9_-]{11})/g)) {
      videoLineIndexes.push({ id: match[1], line: index });
    }
  });

  for (const { id, line } of videoLineIndexes) {
    if (result.has(id)) continue;
    const window = lines.slice(line + 1, line + 6).join('\n');
    const channelLink = window.match(
      /\[([^\]]{1,80})\]\(\s*<?https?:\/\/(?:www\.)?youtube\.com\/(?:@[\w.-]+|c\/[\w.-]+|channel\/[\w-]+)[^)]*>?\s*\)/,
    );
    if (channelLink) {
      const channel = cleanTitle(channelLink[1]);
      if (channel) result.set(id, channel);
    }
  }
  return result;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

const JINA_TIMEOUT_MS = 12_000;
const FIRECRAWL_TIMEOUT_MS = 15_000;

/** Fetch a URL through Jina Reader and return raw markdown text. Throws on failure. */
async function fetchJinaReaderMarkdown(url: string): Promise<string> {
  const key = process.env.JINA_API_KEY?.trim();
  const headers: Record<string, string> = {
    Accept: 'text/plain',
    'X-Return-Format': 'markdown',
  };
  if (key) headers.Authorization = `Bearer ${key}`;

  const response = await fetch(`https://r.jina.ai/${url}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Jina Reader HTTP ${response.status}`);
  }
  const body = await response.text();
  if (!body || body.trim().length < 40) {
    throw new Error('Jina Reader returned an empty page');
  }
  return body;
}

/** Fetch a URL through Firecrawl scrape and return markdown. Throws on failure. */
async function fetchFirecrawlMarkdown(url: string): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY?.trim();
  if (!key) throw new Error('FIRECRAWL_API_KEY is not configured');

  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      // The YouTube search page is a JS app shell, not an article — keep full content
      onlyMainContent: false,
      timeout: 12_000,
    }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firecrawl HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string; content?: string };
  };
  const body = data.data?.markdown ?? data.data?.content ?? '';
  if (!body || body.trim().length < 40) {
    throw new Error('Firecrawl returned an empty page');
  }
  return body;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function playYouTubeVideo(rawQuery: string): Promise<YouTubePlayResult> {
  const t0 = Date.now();
  const query = sanitizePlayQuery(rawQuery);
  const searchUrl = query ? buildYouTubeSearchUrl(query) : '';

  if (!query) {
    return {
      ok: false,
      query: '',
      searchUrl: '',
      searchTimeMs: Date.now() - t0,
      candidates: [],
      error: 'Empty query — nothing to play.',
    };
  }

  const key = normalizeKey(query);
  const cached = getCached(key);
  if (cached) return { ...cached, searchUrl };

  const pending = _inFlight.get(key);
  if (pending) return pending;

  const task = resolveYouTubePlay(query, searchUrl, t0)
    .then(result => {
      setCached(key, result);
      return result;
    })
    .finally(() => {
      if (_inFlight.get(key) === task) _inFlight.delete(key);
    });

  _inFlight.set(key, task);
  return task;
}

async function resolveYouTubePlay(
  query: string,
  searchUrl: string,
  t0: number,
): Promise<YouTubePlayResult> {
  // ── Attempt 1: Jina Reader ──────────────────────────────────────────────
  try {
    logger.info('[YouTubePlay] Jina Reader fetch', { query, searchUrl });
    const markdown = await fetchJinaReaderMarkdown(searchUrl);
    const candidates = parseYouTubeSearchMarkdown(markdown);
    if (candidates.length > 0) {
      return buildResult('jina', query, searchUrl, candidates, t0);
    }
    logger.warn('[YouTubePlay] Jina returned no parseable videos; falling back to Firecrawl', { query });
  } catch (error) {
    logger.warn('[YouTubePlay] Jina failed; falling back to Firecrawl', {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Attempt 2: Firecrawl scrape ─────────────────────────────────────────
  try {
    const markdown = await fetchFirecrawlMarkdown(searchUrl);
    const candidates = parseYouTubeSearchMarkdown(markdown);
    if (candidates.length > 0) {
      return buildResult('firecrawl', query, searchUrl, candidates, t0);
    }
    logger.warn('[YouTubePlay] Firecrawl returned no parseable videos', { query });
  } catch (error) {
    logger.warn('[YouTubePlay] Firecrawl failed', {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Both failed ───────────────────────────────────────────────────────────
  return {
    ok: false,
    query,
    searchUrl,
    searchTimeMs: Date.now() - t0,
    candidates: [],
    error:
      'Could not resolve a playable video from YouTube search right now. ' +
      'Open the search URL in a tab instead.',
  };
}

function buildResult(
  source: 'jina' | 'firecrawl',
  query: string,
  searchUrl: string,
  candidates: YouTubeVideoCandidate[],
  t0: number,
): YouTubePlayResult {
  const first = candidates[0];
  return {
    ok: true,
    query,
    searchUrl,
    searchTimeMs: Date.now() - t0,
    source,
    videoId: first.videoId,
    title: first.title,
    channel: first.channel,
    watchUrl: first.watchUrl,
    embedUrl: first.embedUrl,
    thumbnailUrl: first.thumbnailUrl,
    candidates,
  };
}
