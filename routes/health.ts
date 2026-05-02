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
 *  5. image           — Cloudflare + Pollinations + HuggingFace
 *  6. voice           — Groq TTS + STT
 *  7. endpoints       — Every registered route with method + path + status
 *  8. summary         — Counts: total / healthy / degraded / down
 * 10. checkedAt       — ISO timestamp of this health check run
 *
 * Two modes:
 *   GET /api/health          → fast (env-var checks only, ~5ms)
 *   GET /api/health?probe=1  → deep (live HTTP probes to each provider, ~3-8s)
 *
 * Status values:
 *   ok       — configured and (if probed) reachable
 *   degraded — not configured but not required
 *   down     — required and missing / unreachable
 *   skipped  — probe not requested
 */

import type { Request, Response } from 'express';
import * as os from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

type HealthStatus = 'ok' | 'degraded' | 'down' | 'skipped';

interface ProviderHealth {
  status: HealthStatus;
  configured: boolean;
  required: boolean;
  latencyMs?: number;
  error?: string;
  description: string;
  keyEnvVar: string;
  docsUrl?: string;
}

interface EndpointHealth {
  method: 'GET' | 'POST';
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
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    };
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

async function probeCerebras(): Promise<void> {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error('CEREBRAS_API_KEY not set');
  const res = await fetch('https://api.cerebras.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function probeHuggingFace(): Promise<void> {
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) throw new Error('HUGGINGFACE_API_KEY not set');
  const res = await fetch('https://huggingface.co/api/whoami-v2', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  });
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
  { method: 'GET',  path: '/api/health',              category: 'system',   status: 'registered', description: 'Health check + full system info' },
  // Chat
  { method: 'POST', path: '/api/chat',                category: 'chat',     status: 'registered', description: 'Main chat — full orchestration pipeline' },
  { method: 'POST', path: '/api/chat/personality',    category: 'chat',     status: 'registered', description: 'Chat with user personality + memory system' },
  // AI Tools
  { method: 'POST', path: '/api/ai/search',           category: 'ai',       status: 'registered', description: '6-step web search: Tavily + Firecrawl + AI synthesis' },
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
  { method: 'POST', path: '/api/image/generate',      category: 'image',    status: 'registered', description: 'Image generation: Cloudflare → Pollinations → HuggingFace' },
  { method: 'POST', path: '/api/image/generate-cf',   category: 'image',    status: 'registered', description: 'Cloudflare Workers AI image generation only' },
  // Voice
  { method: 'POST', path: '/api/voice/tts',           category: 'voice',    status: 'registered', description: 'Text-to-Speech via Groq Orpheus TTS' },
  { method: 'POST', path: '/api/voice/transcribe',    category: 'voice',    status: 'registered', description: 'Speech-to-Text via Groq Whisper V3 Turbo' },
  // Memory
  { method: 'POST', path: '/api/memory/extract',      category: 'memory',   status: 'registered', description: 'Extract and store memories from conversation' },
];

// ─── Endpoint self-probe (OPTIONS / HEAD check against own server) ────────────

async function probeEndpoints(baseUrl: string): Promise<EndpointHealth[]> {
  return Promise.all(
    ALL_ENDPOINTS.map(async ep => {
      if (ep.method === 'GET') {
        // Skip self-probing GET /api/health to avoid recursion
        return ep;
      }
      try {
        // Send OPTIONS to check if the route is reachable (no body needed)
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: 'OPTIONS',
          signal: AbortSignal.timeout(2000),
        });
        // 200, 204, 400, 405 all mean the route exists
        const reachable = res.status < 500;
        return { ...ep, status: reachable ? 'registered' : 'unreachable' } as EndpointHealth;
      } catch {
        return { ...ep, status: 'unreachable' } as EndpointHealth;
      }
    })
  );
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function healthHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const probeMode = req.query['probe'] === '1' || req.query['probe'] === 'true';
  const deepEndpoints = req.query['endpoints'] === '1';

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
    groq: envCheck(
      ['GROQ_API_KEY'], true,
      'Primary AI provider — Llama 3.1/3.3, Mixtral, Gemma2',
      'GROQ_API_KEY', 'https://console.groq.com/keys'
    ),
    google: envCheck(
      ['GOOGLE_API_KEY'], false,
      'Google Gemini 2.5 Flash / Pro models',
      'GOOGLE_API_KEY', 'https://aistudio.google.com/app/apikey'
    ),
    cerebras: envCheck(
      ['CEREBRAS_API_KEY'], false,
      'Cerebras ultra-fast inference (Llama 3.1/3.3)',
      'CEREBRAS_API_KEY', 'https://cloud.cerebras.ai'
    ),
    huggingface: envCheck(
      ['HUGGINGFACE_API_KEY'], false,
      'HuggingFace Router — LLMs + FLUX image generation',
      'HUGGINGFACE_API_KEY', 'https://huggingface.co/settings/tokens'
    ),
    openrouter: envCheck(
      ['OPENROUTER_API_KEY'], false,
      'OpenRouter multi-model gateway (100+ models)',
      'OPENROUTER_API_KEY', 'https://openrouter.ai/keys'
    ),
  };

  let search: Record<string, ProviderHealth> = {
    you: envCheck(
      ['YOU_API_KEY'], false,
      'You.com real-time web search — Tier-1 alongside Tavily',
      'YOU_API_KEY', 'https://api.you.com'
    ),
    tavily: envCheck(
      ['TAVILY_API_KEY'], false,
      'Primary web search — real-time, AI-optimised results',
      'TAVILY_API_KEY', 'https://app.tavily.com'
    ),
    firecrawl: envCheck(
      ['FIRECRAWL_API_KEY'], false,
      'Deep content extraction from URLs (full page markdown)',
      'FIRECRAWL_API_KEY', 'https://www.firecrawl.dev'
    ),
    gnews: envCheck(
      ['GNEWS_API_KEY'], false,
      'News articles search',
      'GNEWS_API_KEY', 'https://gnews.io'
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
    duckduckgo: {
      status: 'ok', configured: true, required: false,
      description: 'DuckDuckGo instant answers — free, no key needed',
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
      ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_API_TOKEN'], false,
      'Cloudflare Workers AI — FLUX image generation (primary)',
      'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_API_TOKEN', 'https://dash.cloudflare.com'
    ),
    pollinations: {
      status: 'ok', configured: true, required: false,
      description: 'Pollinations.ai FLUX — free, no key, always available',
      keyEnvVar: 'none',
    },
    huggingfaceFlux: {
      ...envCheck(
        ['HUGGINGFACE_API_KEY'], false,
        'HuggingFace FLUX.1-schnell — fallback image generation',
        'HUGGINGFACE_API_KEY', 'https://huggingface.co/settings/tokens'
      ),
    },
  };

  let voice: Record<string, ProviderHealth> = {
    groqTTS: {
      ...envCheck(
        ['GROQ_API_KEY'], true,
        'Groq Orpheus TTS — voices: troy, diana, hannah, autumn, austin, daniel',
        'GROQ_API_KEY', 'https://console.groq.com/keys'
      ),
    },
    groqSTT: {
      ...envCheck(
        ['GROQ_API_KEY'], true,
        'Groq Whisper V3 Turbo — speech-to-text transcription',
        'GROQ_API_KEY', 'https://console.groq.com/keys'
      ),
    },
  };


  // ── Live probes (only when ?probe=1) ────────────────────────────────────────
  if (probeMode) {
    [
      providers.groq,
      providers.google,
      providers.cerebras,
      providers.huggingface,
      providers.openrouter,
      search.tavily,
      search.firecrawl,
      memory.supabase,
      memory.upstash,
      image.cloudflare,
    ] = await Promise.all([
      liveCheck(providers.groq,        probeGroq),
      liveCheck(providers.google,      probeGoogle),
      liveCheck(providers.cerebras,    probeCerebras),
      liveCheck(providers.huggingface, probeHuggingFace),
      liveCheck(providers.openrouter,  probeOpenRouter),
      liveCheck(search.tavily,         probeTavily),
      liveCheck(search.firecrawl,      probeFirecrawl),
      liveCheck(memory.supabase,       probeSupabase),
      liveCheck(memory.upstash,        probeUpstash),
      liveCheck(image.cloudflare,      probeCloudflare),
    ]);

    // Probe Pollinations (free, always)
    const pollResult = await probe('pollinations', probePollinations, 4000);
    image.pollinations = {
      ...image.pollinations,
      status: pollResult.ok ? 'ok' : 'degraded',
      latencyMs: pollResult.latencyMs,
      error: pollResult.error,
    };
  } else {
    // Mark all as skipped in fast mode
    const markSkipped = (rec: Record<string, ProviderHealth>) => {
      for (const k of Object.keys(rec)) {
        if (rec[k].configured) rec[k] = { ...rec[k], status: 'ok' };
      }
    };
    markSkipped(providers);
    markSkipped(search);
    markSkipped(memory);
    markSkipped(image);
    markSkipped(voice);
  }

  // ── Endpoint verification ────────────────────────────────────────────────────
  let endpoints: EndpointHealth[] = ALL_ENDPOINTS;
  if (deepEndpoints) {
    const proto = req.protocol;
    const host  = req.get('host') ?? `localhost:${process.env.PORT ?? 8080}`;
    const baseUrl = `${proto}://${host}`;
    endpoints = await probeEndpoints(baseUrl);
  }

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
    countDown > 0    ? 'degraded' :
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
    endpoints,
  };

  const httpStatus = overallStatus === 'down' ? 503 : 200;

  // Add timing header
  res.setHeader('X-Health-Check-Ms', String(Date.now() - startTime));
  res.setHeader('Cache-Control', 'no-store');
  res.status(httpStatus).json(report);
}
