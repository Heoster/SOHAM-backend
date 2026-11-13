/**
 * SOHAM Health Check — GET /api/health
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Single endpoint that returns EVERYTHING about the server state:
 *
 *  1. system          — Node version, memory, uptime, platform, env
 *  2. providers       — Live probe of every AI provider API key
 *  3. search          — Tavily + Firecrawl + free fallbacks status
 *  4. memory          — Supabase + Upstash connectivity
 *  5. image           — Cloudflare + Pollinations
 *  6. voice           — Groq TTS + STT
 *  7. endpoints       — Every registered route with method + path + status
 *  8. summary         — Counts: total / healthy / degraded / down
 * 10. checkedAt       — ISO timestamp of this health check run
 *
 * Two modes:
 *   GET /api/health          → fast config + model availability report
 *   GET /api/health/live     → liveness probe
 *   GET /api/health/ready    → model-provider readiness probe
 *   GET /api/health?probe=1  → authenticated live probes (may consume provider quota)
 *
 * Status values:
 *   ok       — configured and (if probed) reachable
 *   degraded — not configured but not required
 *   down     — required and missing / unreachable
 */

import type { Request, Response } from 'express';
import * as os from 'os';
import { getModelRegistry } from '../routing/model-registry';

// ─── Types ────────────────────────────────────────────────────────────────────

type HealthStatus = 'ok' | 'degraded' | 'down';

interface ProviderHealth {
  status: HealthStatus;
  configured: boolean;
  required: boolean;
  latencyMs?: number;
  error?: string;
  description: string;
  keyEnvVar: string;
  docsUrl?: string;
  note?: string;
}

interface EndpointHealth {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  category: string;
  status: 'registered' | 'unreachable';
  description: string;
}

interface HealthReport {
  status: HealthStatus;
  server: string;
  version: string;
  checkedAt: string;
  probeMode: boolean;
  system: SystemInfo;
  summary: HealthSummary;
  providers: Record<string, ProviderHealth>;
  search: Record<string, ProviderHealth>;
  memory: Record<string, ProviderHealth>;
  image: Record<string, ProviderHealth>;
  voice: Record<string, ProviderHealth>;
  models: { total: number; available: number; groqFreePlanGate: boolean; entries: Array<{ id: string; provider: string; modelId: string; available: boolean }> };
  endpoints: EndpointHealth[];
}

interface SystemInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  uptimeHuman: string;
  memoryMB: { used: number; total: number; free: number };
  cpuCount: number;
  environment: string;
  port: string | number;
  timezone: string;
}

interface HealthSummary {
  totalProviders: number;
  ok: number;
  degraded: number;
  down: number;
  totalEndpoints: number;
  registeredEndpoints: number;
  overallStatus: HealthStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

async function probe(
  _name: string,
  fn: () => Promise<void>,
  timeoutMs = 5000
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Provider probe functions ─────────────────────────────────────────────────

async function probeGroq(): Promise<void> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeGoogle(): Promise<void> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeOpenRouter(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeTavily(): Promise<void> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: 'test', max_results: 1 }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeFirecrawl(): Promise<void> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY not set');
  // Use the /v1/scrape endpoint with a minimal request
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'], timeout: 3000 }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeGNews(): Promise<void> {
  const key = process.env.GNEWS_API_KEY;
  if (!key) throw new Error('GNEWS_API_KEY not set');
  const url = `https://gnews.io/api/v4/search?q=health%20check&lang=en&max=1&apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { errors?: string[] };
  if (data.errors?.length) throw new Error('GNews rejected the health query');
}

async function probeNewsApi(): Promise<void> {
  const key = process.env.NEWS_API_KEY;
  if (!key) throw new Error('NEWS_API_KEY not set');
  const params = new URLSearchParams({ q: 'health check', pageSize: '1', sortBy: 'publishedAt' });
  const res = await fetch(`https://newsapi.org/v2/everything?${params}`, {
    headers: { 'X-Api-Key': key },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { status?: string; message?: string };
  if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI rejected the health query');
}

async function probeCricApi(): Promise<void> {
  const key = process.env.CRICAPI_KEY;
  if (!key) throw new Error('CRICAPI_KEY not set');
  const url = `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(key)}&offset=0`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { status?: string; reason?: string };
  if (data.status && data.status.toLowerCase() !== 'success') throw new Error(data.reason || 'CricAPI returned a non-success status');
}

async function probeAlphaVantage(): Promise<void> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error('ALPHA_VANTAGE_API_KEY not set');
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  if (data['Error Message'] || data['Information'] || data['Note']) throw new Error('Alpha Vantage returned an API error or quota notice');
}

async function probeYouCom(): Promise<void> {
  const key = process.env.YOU_API_KEY;
  if (!key) throw new Error('YOU_API_KEY not set');
  const res = await fetch('https://api.ydc-index.io/search?query=health%20check&num_web_results=1', {
    headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeDuckDuckGo(): Promise<void> {
  const res = await fetch('https://api.duckduckgo.com/?q=health+check&format=json&no_html=1', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeWikipedia(): Promise<void> {
  const res = await fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=health%20check&srlimit=1&format=json', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeOpenMeteo(): Promise<void> {
  const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=28.9845&longitude=77.7064&current=temperature_2m', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeCoinGecko(): Promise<void> {
  const res = await fetch('https://api.coingecko.com/api/v3/ping', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeSupabase(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY not set');
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeUpstash(): Promise<void> {
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_VECTOR_REST_URL or TOKEN not set');
  const res = await fetch(`${url}/info`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeCloudflare(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_API_TOKEN;
  if (!accountId || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_AI_API_TOKEN not set');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probePollinations(): Promise<void> {
  const res = await fetch('https://image.pollinations.ai/models', {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ─── Build provider health entry ─────────────────────────────────────────────

function envCheck(
  envVars: string[],
  required: boolean,
  description: string,
  keyEnvVar: string,
  docsUrl?: string
): ProviderHealth {
  const configured = envVars.every(v => !!process.env[v]);
  return {
    status: configured ? 'ok' : required ? 'down' : 'degraded',
    configured,
    required,
    description,
    keyEnvVar,
    docsUrl,
  };
}

async function liveCheck(
  base: ProviderHealth,
  probeFn: () => Promise<void>
): Promise<ProviderHealth> {
  if (!base.configured) return base;
  const result = await probe(base.keyEnvVar, probeFn);
  return {
    ...base,
    status: result.ok ? 'ok' : 'down',
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

// ─── All registered endpoints ─────────────────────────────────────────────────

const ALL_ENDPOINTS: EndpointHealth[] = [
  // System
  { method: 'GET',  path: '/api/health',              category: 'system',   status: 'registered', description: 'Detailed health, provider, service, and model catalog report' },
  { method: 'GET',  path: '/api/health/live',         category: 'system',   status: 'registered', description: 'Liveness probe for process supervisor' },
  { method: 'GET',  path: '/api/health/ready',        category: 'system',   status: 'registered', description: 'Readiness probe requiring at least one configured active model' },
  { method: 'GET',  path: '/api/health/services',     category: 'system',   status: 'registered', description: 'Detailed provider and domain-service checks' },
  // Chat
  { method: 'POST', path: '/api/chat',                category: 'chat',     status: 'registered', description: 'Main chat — full orchestration pipeline' },
  { method: 'POST', path: '/api/chat/personality',    category: 'chat',     status: 'registered', description: 'Chat with user personality + memory system' },
  { method: 'POST', path: '/api/chat/stream',         category: 'chat',     status: 'registered', description: 'Server-sent event chat stream; tool turns stream final response after tool loop' },
  // AI Tools
  { method: 'POST', path: '/api/ai/search',           category: 'ai',       status: 'registered', description: 'Multi-provider web/news search with citations and AI synthesis' },
  { method: 'POST', path: '/api/ai/solve',            category: 'ai',       status: 'registered', description: 'Math / problem solver with step-by-step solutions' },
  { method: 'POST', path: '/api/ai/summarize',        category: 'ai',       status: 'registered', description: 'Text summarization (brief/detailed/bullets/eli5)' },
  { method: 'POST', path: '/api/ai/image-solver',     category: 'ai',       status: 'registered', description: 'Solve equations from images (visual math)' },
  { method: 'POST', path: '/api/ai/pdf-analyzer',     category: 'ai',       status: 'registered', description: 'Analyze PDF documents and answer questions' },
  // Skills v2
  { method: 'POST', path: '/api/ai/translate',        category: 'skills',   status: 'registered', description: 'Multi-language translation with auto source detection' },
  { method: 'POST', path: '/api/ai/sentiment',        category: 'skills',   status: 'registered', description: 'Sentiment + emotion analysis' },
  { method: 'POST', path: '/api/ai/classify',         category: 'skills',   status: 'registered', description: 'Text classification (custom or auto categories)' },
  { method: 'POST', path: '/api/ai/grammar',          category: 'skills',   status: 'registered', description: 'Grammar correction and writing improvement' },
  { method: 'POST', path: '/api/ai/quiz',             category: 'skills',   status: 'registered', description: 'Quiz / flashcard generator' },
  { method: 'POST', path: '/api/ai/recipe',           category: 'skills',   status: 'registered', description: 'Recipe generator from ingredients or cuisine' },
  { method: 'POST', path: '/api/ai/joke',             category: 'skills',   status: 'registered', description: 'Joke / pun / roast / riddle / fun-fact generator' },
  { method: 'POST', path: '/api/ai/dictionary',       category: 'skills',   status: 'registered', description: 'Word definitions, synonyms, etymology' },
  { method: 'POST', path: '/api/ai/fact-check',       category: 'skills',   status: 'registered', description: 'Fact-checking with web search + AI reasoning' },
  // Image
  { method: 'POST', path: '/api/image/generate',      category: 'image',    status: 'registered', description: 'Image generation: Pollinations, with Cloudflare behind explicit opt-in' },
  { method: 'POST', path: '/api/image/generate-cf',   category: 'image',    status: 'registered', description: 'Cloudflare Workers AI image generation only' },
  // Voice
  { method: 'POST', path: '/api/voice/tts',           category: 'voice',    status: 'registered', description: 'Browser text-to-speech fallback; provider TTS disabled' },
  { method: 'POST', path: '/api/voice/transcribe',    category: 'voice',    status: 'registered', description: 'Browser speech recognition fallback; provider STT disabled' },
  // Memory
  { method: 'POST', path: '/api/memory/extract',      category: 'memory',   status: 'registered', description: 'Extract and store memories from conversation' },
  { method: 'GET', path: '/api/memory/profile/:userId', category: 'memory', status: 'registered', description: 'Read user profile memory' },
  { method: 'POST', path: '/api/memory/profile/:userId', category: 'memory', status: 'registered', description: 'Create or update user profile memory' },
  { method: 'DELETE', path: '/api/memory/profile/:userId', category: 'memory', status: 'registered', description: 'Delete user profile memory' },
  { method: 'POST', path: '/api/memory/knowledge', category: 'memory', status: 'registered', description: 'Store knowledge base facts' },
  { method: 'POST', path: '/api/memory/knowledge/search', category: 'memory', status: 'registered', description: 'Search memory knowledge base' },
  { method: 'POST', path: '/api/memory/knowledge/correction', category: 'memory', status: 'registered', description: 'Store memory corrections' },
  { method: 'POST', path: '/api/memory/knowledge/suggestion', category: 'memory', status: 'registered', description: 'Submit memory suggestions' },
];

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function healthHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const probeMode = req.query['probe'] === '1' || req.query['probe'] === 'true';
  if (probeMode) {
    const expected = process.env.SOHAM_API_KEY;
    if (!expected || req.get('authorization') !== `Bearer ${expected}`) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ status: 'unauthorized', error: 'Deep provider probes require the backend API key.' });
      return;
    }
  }

  // ── System info ─────────────────────────────────────────────────────────────
  const memTotal = os.totalmem();
  const memFree  = os.freemem();
  const memUsed  = memTotal - memFree;
  const uptimeSec = process.uptime();

  const system: SystemInfo = {
    nodeVersion:   process.version,
    platform:      process.platform,
    arch:          process.arch,
    uptimeSeconds: Math.floor(uptimeSec),
    uptimeHuman:   formatUptime(uptimeSec),
    memoryMB: {
      used:  Math.round(memUsed  / 1024 / 1024),
      total: Math.round(memTotal / 1024 / 1024),
      free:  Math.round(memFree  / 1024 / 1024),
    },
    cpuCount:    os.cpus().length,
    environment: process.env.NODE_ENV ?? 'development',
    port:        process.env.PORT ?? 8080,
    timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  // ── Build provider entries (env-var check first) ───────────────────────────
  let providers: Record<string, ProviderHealth> = {
    groq: (() => {
      const freePlanConfirmed = process.env.GROQ_FREE_PLAN_ONLY === 'true';
      const configured = Boolean(process.env.GROQ_API_KEY) && freePlanConfirmed;
      return {
        status: configured ? 'ok' as const : 'degraded' as const,
        configured,
        required: false,
        description: 'Groq GPT-OSS / Qwen chat and tools; gated to confirmed $0 Free-plan accounts',
        keyEnvVar: 'GROQ_API_KEY + GROQ_FREE_PLAN_ONLY',
        docsUrl: 'https://console.groq.com/docs/models',
        note: freePlanConfirmed ? 'Free-plan-only opt-in is enabled.' : 'Disabled until GROQ_FREE_PLAN_ONLY=true is explicitly set.',
      };
    })(),
    google: envCheck(
      ['GOOGLE_API_KEY'], false,
      'Google Gemini models with documented free-tier routes',
      'GOOGLE_API_KEY', 'https://aistudio.google.com/app/apikey'
    ),
    openrouter: envCheck(
      ['OPENROUTER_API_KEY'], false,
      'OpenRouter model gateway',
      'OPENROUTER_API_KEY', 'https://openrouter.ai/keys'
    ),
    cloudflareAI: {
      status: 'degraded', configured: false, required: false,
      description: 'Cloudflare Workers AI text chat is disabled; image generation is separately gated.',
      keyEnvVar: 'ENABLE_CLOUDFLARE_IMAGE_AI', docsUrl: 'https://dash.cloudflare.com',
    },
  };

  let search: Record<string, ProviderHealth> = {
    you: envCheck(
      ['YOU_API_KEY'], false,
      'You.com real-time web search — optional search source',
      'YOU_API_KEY', 'https://documentation.you.com/api-reference'
    ),
    tavily: envCheck(
      ['TAVILY_API_KEY'], false,
      'Primary web search — real-time, AI-optimised results',
      'TAVILY_API_KEY', 'https://app.tavily.com'
    ),
    brave: envCheck(
      ['BRAVE_SEARCH_API_KEY'], false,
      'Brave web and news search — optional configured search source',
      'BRAVE_SEARCH_API_KEY', 'https://brave.com/search/api/'
    ),
    serpapi: envCheck(
      ['SERPAPI_KEY'], false,
      'Google web and news results through SerpApi — optional configured source',
      'SERPAPI_KEY', 'https://serpapi.com'
    ),
    jina: envCheck(
      ['JINA_API_KEY'], false,
      'Jina live web search with uncached mode for current/news queries',
      'JINA_API_KEY', 'https://jina.ai'
    ),
    firecrawl: envCheck(
      ['FIRECRAWL_API_KEY'], false,
      'Firecrawl web/news search and deep content extraction from URLs',
      'FIRECRAWL_API_KEY', 'https://www.firecrawl.dev'
    ),
    gnews: envCheck(
      ['GNEWS_API_KEY'], false,
      'GNews articles search',
      'GNEWS_API_KEY', 'https://gnews.io'
    ),
    newsapi: envCheck(
      ['NEWS_API_KEY'], false,
      'NewsAPI.org live article search',
      'NEWS_API_KEY', 'https://newsapi.org'
    ),
    cricapi: envCheck(
      ['CRICAPI_KEY'], false,
      'Live cricket scores and match data',
      'CRICAPI_KEY', 'https://cricapi.com'
    ),
    alphaVantage: envCheck(
      ['ALPHA_VANTAGE_API_KEY'], false,
      'Stock market prices and financial data',
      'ALPHA_VANTAGE_API_KEY', 'https://alphavantage.co'
    ),
    googleNewsRss: {
      status: 'ok', configured: true, required: false,
      description: 'Google News RSS live article search — no key needed',
      keyEnvVar: 'none',
    },
    duckduckgo: {
      status: 'ok', configured: true, required: false,
      description: 'DuckDuckGo HTML web search with Instant Answer fallback — no key needed',
      keyEnvVar: 'none',
    },
    wikipedia: {
      status: 'ok', configured: true, required: false,
      description: 'Wikipedia search + summaries — free, no key needed',
      keyEnvVar: 'none',
    },
    openMeteo: {
      status: 'ok', configured: true, required: false,
      description: 'Weather data — free, no key needed',
      keyEnvVar: 'none',
    },
    coinGecko: {
      status: 'ok', configured: true, required: false,
      description: 'Crypto prices — free, no key needed',
      keyEnvVar: 'none',
    },
  };

  let memory: Record<string, ProviderHealth> = {
    supabase: envCheck(
      ['SUPABASE_URL', 'SUPABASE_ANON_KEY'], false,
      'Cross-device chat history + image rate limits (PostgreSQL)',
      'SUPABASE_URL + SUPABASE_ANON_KEY', 'https://supabase.com/dashboard'
    ),
    upstash: envCheck(
      ['UPSTASH_VECTOR_REST_URL', 'UPSTASH_VECTOR_REST_TOKEN'], false,
      'RAG vector memory — semantic similarity search',
      'UPSTASH_VECTOR_REST_URL + UPSTASH_VECTOR_REST_TOKEN', 'https://console.upstash.com/vector'
    ),
  };

  let image: Record<string, ProviderHealth> = {
    cloudflare: envCheck(
      ['ENABLE_CLOUDFLARE_IMAGE_AI', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_API_TOKEN'], false,
      'Cloudflare Workers AI image generation (explicit opt-in; may be billable over free quota)',
      'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_API_TOKEN', 'https://dash.cloudflare.com'
    ),
    pollinations: {
      status: 'ok', configured: true, required: false,
      description: 'Pollinations.ai FLUX — free, no key, always available',
      keyEnvVar: 'none',
    },
  };

  let voice: Record<string, ProviderHealth> = {
    browserTTS: { status: 'ok', configured: true, required: false, description: 'Browser-provided text-to-speech; no provider API call', keyEnvVar: 'none' },
    browserSTT: { status: 'ok', configured: true, required: false, description: 'Browser-provided speech recognition; no provider API call', keyEnvVar: 'none' },
  };


  // ── Live probes are explicit because keyed search APIs may consume quota. ──
  if (probeMode) {
    const checks: Array<[Record<string, ProviderHealth>, string, () => Promise<void>]> = [
      [providers, 'groq', probeGroq], [providers, 'google', probeGoogle],
      [providers, 'openrouter', probeOpenRouter],
      [search, 'you', probeYouCom], [search, 'tavily', probeTavily],
      [search, 'firecrawl', probeFirecrawl], [search, 'gnews', probeGNews], [search, 'newsapi', probeNewsApi],
      [search, 'cricapi', probeCricApi], [search, 'alphaVantage', probeAlphaVantage],
      [search, 'duckduckgo', probeDuckDuckGo], [search, 'wikipedia', probeWikipedia],
      [search, 'openMeteo', probeOpenMeteo], [search, 'coinGecko', probeCoinGecko],
      [memory, 'supabase', probeSupabase], [memory, 'upstash', probeUpstash],
      [image, 'cloudflare', probeCloudflare], [image, 'pollinations', probePollinations],
    ];
    await Promise.all(checks.map(async ([group, name, fn]) => {
      const base = group[name];
      if (!base) return;
      group[name] = await liveCheck(base, fn);
    }));
  }

  // Models and availability reflect the same feature gates used by runtime routing.
  const registry = getModelRegistry();
  const catalog = registry.getAvailableModels();
  const models = {
    total: registry.getAllModels().length,
    available: catalog.length,
    groqFreePlanGate: process.env.GROQ_FREE_PLAN_ONLY === 'true',
    entries: registry.getAllModels().map(model => ({
      id: model.id, provider: model.provider, modelId: model.modelId,
      available: registry.isModelAvailable(model.id),
    })),
  };

  const endpoints: EndpointHealth[] = ALL_ENDPOINTS;

  // ── Summary ──────────────────────────────────────────────────────────────────
  const allProviders = [
    ...Object.values(providers),
    ...Object.values(search),
    ...Object.values(memory),
    ...Object.values(image),
    ...Object.values(voice),
  ];

  const countOk       = allProviders.filter(p => p.status === 'ok').length;
  const countDegraded = allProviders.filter(p => p.status === 'degraded').length;
  const countDown     = allProviders.filter(p => p.status === 'down').length;

  const requiredDown = allProviders.filter(p => p.required && p.status === 'down').length;
  const overallStatus: HealthStatus =
    requiredDown > 0 ? 'down' :
    countDown > 0 || models.available === 0 ? 'degraded' :
    'ok';

  const summary: HealthSummary = {
    totalProviders:      allProviders.length,
    ok:                  countOk,
    degraded:            countDegraded,
    down:                countDown,
    totalEndpoints:      endpoints.length,
    registeredEndpoints: endpoints.filter(e => e.status === 'registered').length,
    overallStatus,
  };

  const report: HealthReport = {
    status:    overallStatus,
    server:    'SOHAM Backend',
    version:   '1.0.0',
    checkedAt: new Date().toISOString(),
    probeMode,
    system,
    summary,
    providers,
    search,
    memory,
    image,
    voice,
    models,
    endpoints,
  };

  const httpStatus = overallStatus === 'down' ? 503 : 200;

  // Add timing header
  res.setHeader('X-Health-Check-Ms', String(Date.now() - startTime));
  res.setHeader('Cache-Control', 'no-store');
  res.status(httpStatus).json(report);
}


/** Cheap process liveness probe: no API keys, network calls, or model inference. */
export function healthLiveHandler(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ status: 'alive', service: 'soham-backend', uptimeSeconds: Math.floor(process.uptime()), checkedAt: new Date().toISOString() });
}

/** Readiness requires at least one catalog model whose provider gates and credentials are active. */
export function healthReadyHandler(_req: Request, res: Response): void {
  const registry = getModelRegistry();
  const models = registry.getAvailableModels();
  const ready = models.length > 0;
  res.setHeader('Cache-Control', 'no-store');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    service: 'soham-backend',
    availableModelCount: models.length,
    availableProviders: [...new Set(models.map(model => model.provider))],
    checkedAt: new Date().toISOString(),
  });
}
