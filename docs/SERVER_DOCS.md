# SOHAM Backend Server — Complete Documentation

> **"Everything intelligent happens here"**
> The backend is responsible for: Thinking, Deciding, Fetching data, Generating answers.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Start](#quick-start)
3. [All Endpoints](#all-endpoints)
4. [Core Systems](#core-systems)
5. [AI Model Providers](#ai-model-providers)
6. [Search System](#search-system)
7. [Memory System](#memory-system)
8. [Image Generation](#image-generation)
9. [Voice System](#voice-system)
10. [Safety & Rate Limiting](#safety--rate-limiting)
11. [Environment Variables](#environment-variables)
12. [Deployment](#deployment)
13. [Future Expansion](#future-expansion)

---

## Architecture

```
User Input
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│                    SOHAM Backend Server                          │
│                                                                  │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │ Intent Detector │───▶│   Orchestrator   │                    │
│  │ (core/)         │    │   (core/)        │                    │
│  └─────────────────┘    └────────┬─────────┘                    │
│                                  │                               │
│              ┌───────────────────┼───────────────────┐          │
│              ▼                   ▼                   ▼          │
│  ┌───────────────────┐ ┌──────────────────┐ ┌──────────────┐   │
│  │   Tool Execution  │ │   RAG Context    │ │   Memory     │   │
│  │   (tools/)        │ │   (memory/)      │ │   (memory/)  │   │
│  └───────────────────┘ └──────────────────┘ └──────────────┘   │
│              │                   │                   │          │
│              └───────────────────┼───────────────────┘          │
│                                  ▼                               │
│                    ┌─────────────────────────┐                  │
│                    │   Smart Fallback AI      │                  │
│                    │ Google free tier →      │                  │
│                    │ OpenRouter free router  │                  │
│                    │   (routing/)             │                  │
│                    └─────────────────────────┘                  │
│                                  │                               │
└──────────────────────────────────┼──────────────────────────────┘
                                   ▼
                            Final Answer
```

---

## Quick Start

```bash
# 1. Install dependencies
cd server
npm install

# 2. Set up environment
cp env.example .env
# Edit .env — set GOOGLE_API_KEY or OPENROUTER_API_KEY

# 3. Run in development
npm run dev

# 4. Test health
curl http://localhost:8080/api/health
```

**Minimum requirement:** Configure `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, or `GROQ_API_KEY` plus `GROQ_FREE_PLAN_ONLY=true` for a confirmed Groq Free-plan account. Groq is an optional, Free-plan-only route; set `GROQ_FREE_PLAN_ONLY=true` only when the Groq organization is on the $0 Free plan. No paid model fallback is configured.

---

## All Endpoints

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Main chat — full orchestration pipeline |
| POST | `/api/chat/personality` | Chat with user personality + memory system |

### AI Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/ai/search` | 6-step web search + AI synthesis |
| POST | `/api/ai/solve` | Math / problem solver (step-by-step) |
| POST | `/api/ai/summarize` | Text summarization (brief/detailed/bullets/eli5) |
| POST | `/api/ai/image-solver` | Solve equations from images (visual math) |
| POST | `/api/ai/pdf-analyzer` | Analyze PDF documents, answer questions |

### Image Generation

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/image/generate` | Opt-in Cloudflare image generation, falling back to Pollinations |
| POST | `/api/image/generate-cf` | Cloudflare Workers AI only (explicit opt-in required) |
| GET | `/api/image/generate-cf` | Non-generative CF image capability/configuration check |

### Video

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/video/generate` | Google Veo 3.1 video generation |

### Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/voice/tts` | Text-to-Speech (Groq Orpheus) |
| POST | `/api/voice/transcribe` | Speech-to-Text (Groq Whisper V3 Turbo) |

### Memory

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/memory/extract` | Extract & store memories from conversation |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Provider status, endpoint list, config check |

---

## Endpoint Reference

### `POST /api/chat`

Full SOHAM orchestration: safety → classification → tools → RAG → AI → memory persist.

**Request:**
```json
{
  "message": "What is the weather in Mumbai today?",
  "history": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi! How can I help?" }
  ],
  "settings": {
    "model": "auto",
    "tone": "helpful",
    "technicalLevel": "intermediate"
  },
  "userId": "user_abc123"
}
```

**Response:**
```json
{
  "success": true,
  "content": "Current weather in Mumbai: 32°C, humidity 78%...",
  "modelUsed": "gemini-3.6-flash",
  "autoRouted": false,
  "routingReasoning": "Direct model usage",
  "toolsUsed": [{ "tool": "weather_search", "query": "Mumbai", "ok": true, "output": "..." }],
  "ragContextCount": 2,
  "crossDeviceHistoryCount": 4,
  "responseTime": "1240ms",
  "timestamp": "2025-04-18T12:00:00.000Z"
}
```

---

### `POST /api/ai/search`

6-step search pipeline. See [Search System docs](./SEARCH_SYSTEM.md) for full details.

**Request:**
```json
{
  "query": "latest AI news 2025",
  "preferredModel": "gemini-3.6-flash",
  "maxResults": 8,
  "includeTrace": false
}
```

**Response:**
```json
{
  "success": true,
  "answer": "In 2025, AI has seen major advances... [1][2][3]\n\n**Sources:**\n[1] [Title](url)",
  "sources": [{ "index": 1, "title": "...", "url": "...", "snippet": "...", "source": "brave" }],
  "queryType": "news",
  "modelUsed": "gemini-3.6-flash",
  "searchTimeMs": 1240,
  "totalSources": 6,
  "responseTime": "1890ms"
}
```

---

### `POST /api/ai/solve`

**Request:**
```json
{
  "problem": "Solve: 2x² + 5x - 3 = 0",
  "tone": "helpful",
  "technicalLevel": "intermediate",
  "preferredModel": "gemini-3.5-flash-lite"
}
```

---

### `POST /api/ai/summarize`

**Request:**
```json
{
  "text": "Long article text here...",
  "style": "bullets",
  "preferredModel": "gemini-3.6-flash"
}
```

`style` options: `brief` | `detailed` | `bullets` | `eli5`

---

### `POST /api/image/generate`

**Request:**
```json
{
  "prompt": "A futuristic city at sunset with flying cars",
  "userId": "user_abc123",
  "style": "realistic"
}
```

`style` options: `realistic` | `artistic` | `anime` | `sketch`

Rate limit: 10 images per user per day (UTC).

---

### `POST /api/voice/tts`

**Request:**
```json
{
  "text": "Hello, I am SOHAM, your AI assistant.",
  "voice": "troy",
  "speed": 1.0
}
```

`voice` options: `troy` | `diana` | `hannah` | `autumn` | `austin` | `daniel`

**Response:**
```json
{
  "success": true,
  "audio": "<base64-encoded WAV>",
  "provider": "groq",
  "model": "playai-tts",
  "contentType": "audio/wav"
}
```

---

### `POST /api/voice/transcribe`

**Request:** `multipart/form-data`
- `file`: audio file (webm, mp3, wav, m4a)
- `language`: (optional) language code, e.g. `en`

**Response:**
```json
{
  "success": true,
  "text": "Hello, how are you?",
  "language": "en",
  "provider": "groq",
  "model": "whisper-large-v3-turbo"
}
```

---

### `GET /api/health`

Returns full system status. Use this to debug configuration issues.

```json
{
  "status": "ok",
  "providers": {
    "groq": { "configured": true, "required": true },
    "google": { "configured": false, "required": false }
  },
  "imageProviders": { "cloudflare": { "configured": false }, "pollinations": { "configured": true } },
  "memoryProviders": { "supabase": { "configured": false }, "upstash": { "configured": false } },
  "endpoints": { "chat": "POST /api/chat", ... }
}
```

---

## Core Systems

### Intent Detector (`core/intent-detector.ts`)

Classifies every user message before routing:

| Intent | Confidence Threshold | Action |
|--------|---------------------|--------|
| `WEB_SEARCH` | > 0.7 | Run search pipeline |
| `IMAGE_GENERATION` | > 0.7 | Run image pipeline |
| `CODE_GENERATION` | > 0.6 | Route to coding model |
| `EXPLANATION` | > 0.6 | Route to general model |
| `CHAT` | default | General conversation |

### Orchestrator (`core/orchestrator.ts`)

Builds enriched context before every AI call:

```
buildSohamPromptContext(message, userId)
    │
    ├── executeSohamTool(message)      → weather/news/sports/finance/web
    ├── queryRagContext(userId, msg)   → Upstash Vector similarity search
    └── loadCrossDeviceHistory(userId) → Supabase chat history
    │
    └── Returns: enriched prompt with all context blocks
```

---


### Health monitoring

- `GET /api/health/live` is a cheap, unauthenticated process liveness check.
- `GET /api/health/ready` returns `200` only when at least one model in the enabled catalog has its provider credentials and feature gates configured; otherwise it returns `503`.
- `GET /api/health` and `/api/health/services` report system resources, model availability, and integration configuration for Groq, Google, OpenRouter, GNews, NewsAPI.org, Google News RSS, Tavily, Brave, SerpApi, Jina, Firecrawl, You.com, CricAPI, Alpha Vantage, Wikipedia, DuckDuckGo, Open-Meteo, CoinGecko, Supabase, Upstash, image, and browser voice services.
- `?probe=1` performs authenticated network probes. Send `Authorization: Bearer $SOHAM_API_KEY`. Probes to keyed services such as GNews, Tavily, Firecrawl, CricAPI, and Alpha Vantage may consume provider quota; the normal health endpoint only checks configuration and does not call them.

## AI Model Providers

### Provider Priority (Smart Fallback)

```
Groq Free plan (explicit opt-in) → Google Gemini free tier → OpenRouter free-only router → Cloudflare Workers AI (explicit text opt-in)
```


The active model catalog lives in `routing/models-config.json`. It contains Google Gemini free-tier models, OpenRouter's dynamic free router, Groq GPT-OSS 120B / GPT-OSS 20B / Qwen 3.8 27B, and opt-in Cloudflare Workers AI Granite 4.0 H Micro / GPT-OSS 20B. Groq is unavailable unless `GROQ_FREE_PLAN_ONLY=true`; only use that opt-in with a confirmed $0 Free-plan Groq account. Cloudflare text models are available only when `ENABLE_CLOUDFLARE_TEXT_AI=true` and account credentials are configured. SOHAM uses Cloudflare's documented OpenAI-compatible `POST /accounts/{account_id}/ai/v1/chat/completions` endpoint; create a token with Workers AI Read and Edit permissions. Cloudflare has a shared 10,000-Neuron daily free allocation; overage requires Workers Paid and is billed, so the feature flag is not a spending cap. As checked against Cloudflare's [pricing table](https://developers.cloudflare.com/workers-ai/platform/pricing/) on 2026-11-13, Granite 4.0 H Micro is listed at $0.017/M input and $0.112/M output tokens; GPT-OSS 20B is listed at $0.20/M input and $0.30/M output tokens. Prices and model availability can change. The intent router only chooses IDs in the enabled catalog; category routing is supplemented by all enabled providers so model categories cannot hide cross-provider fallback choices. Model IDs and provider lifecycle should be reviewed against each provider's model catalog when updating this file.

### Model Selection

- `"model": "auto"` → Auto-router picks best model for query type
- `"model": "gemini-3.6-flash"` → Use a catalog model; fallback stays within enabled providers
- `"model": "cloudflare-granite-4-micro"` or `"cloudflare-gpt-oss-20b"` → Cloudflare Workers AI, only with its explicit text opt-in enabled
- Smart fallback automatically switches on failure (rate limit, timeout, error)

### Groq Tools (Free-plan opt-in)

Set `GROQ_API_KEY` and `GROQ_FREE_PLAN_ONLY=true` only for an account confirmed on Groq's $0 Free plan. GPT-OSS 20B/120B support Groq built-ins `browser_search` and `code_interpreter`. GPT-OSS and Qwen 3.8 27B can also use SOHAM's allowlisted local function tools, which dispatch into the existing web/news (including GNews), weather, sports, and finance services.

```json
{
  "message": "Find recent AI news and summarize it",
  "settings": {
    "model": "groq-gpt-oss-120b",
    "groqBuiltinTools": ["browser_search"],
    "enableLocalToolCalling": true
  }
}
```

Built-in tools are opt-in per request to avoid unexpected searches or code execution. `groqBuiltinTools` only accepts `browser_search` and `code_interpreter`; local tool calls are allowlisted and limited to three execution rounds. With local function calling enabled, chat/stream uses a complete response event for the tool loop and then emits the final text.

---

## Search System

See [SEARCH_SYSTEM.md](./SEARCH_SYSTEM.md) for complete documentation.

**Quick summary:**
- 6-step pipeline: Analysis → Source Selection → Parallel Fetch → Merge → AI Synthesis → Citations
- Sources: Tavily, You.com, Brave, SerpApi, Jina, Firecrawl Search, GNews, Google News RSS, Wikipedia, DuckDuckGo, Open-Meteo, CoinGecko, CricAPI
- Works with zero API keys (Google News RSS and DuckDuckGo web search are always available)
- Configured search providers run together; free sources remain active as fallbacks
- `BRAVE_SEARCH_API_KEY` and `SERPAPI_KEY` are supported when configured

---

## Memory System

### Short-term Memory (Cross-device History)
- **Storage:** Supabase PostgreSQL (`chat_history` table)
- **Scope:** Per user, last N messages
- **Used for:** Continuing conversations across devices

### Long-term Memory (RAG)
- **Storage:** Upstash Vector (vector embeddings)
- **Scope:** Per user, semantic similarity search
- **Used for:** Recalling relevant past context

### Memory Extraction
- **Endpoint:** `POST /api/memory/extract`
- **When:** Called asynchronously after each conversation turn
- **What:** Extracts facts, preferences, skills from conversation

### Without Memory (no keys configured)
The system works fine — memory features are silently skipped. No errors.

---

## Image Generation

### Pipeline (Fallback Chain)

```
1. Cloudflare Workers AI FLUX.1 schnell (only when explicitly enabled)
2. Pollinations.ai (no key; fallback)
```

The direct Cloudflare image route is `POST /api/image/generate-cf` with `{ "prompt": "...", "steps": 4 }`; FLUX.1 schnell accepts prompts up to 2048 characters and 1–8 inference steps. Its output is returned as an image data URI. `GET /api/image/generate-cf` reports whether the feature is configured without generating an image. The model API does not expose a documented aspect-ratio input, so output dimensions are model-controlled.

Cloudflare image generation requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, and `ENABLE_CLOUDFLARE_IMAGE_AI=true`. It is disabled by default. Workers AI currently includes 10,000 Neurons/day across the account; additional usage requires Workers Paid and is billed at the rate shown in Cloudflare's [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). The current FLUX.1 schnell price is listed as 4.8 Neurons per 512x512 tile plus 9.6 Neurons per step; image charges depend on tile count and steps. The gate is an explicit opt-in, not a billing cap. Pollinations requires no key.

### Rate Limiting
- 10 images per user per day (UTC)
- Tracked in Supabase (falls back to in-memory if Supabase unavailable)
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## Voice System

### Text-to-Speech
- **Primary:** Groq Orpheus TTS (`playai-tts`)
- **Voices:** troy, diana, hannah, autumn, austin, daniel
- **Format:** WAV audio, base64 encoded
- **Max text:** 4000 characters (auto-truncated)

### Speech-to-Text
- **Primary:** Groq Whisper V3 Turbo
- **Formats:** webm, mp3, wav, m4a
- **Languages:** Auto-detect or specify

---

## Safety & Rate Limiting

### Input Safety (`safety/safety-guard-service.ts`)
- Checks every message before processing
- Blocks: harmful content, prompt injection, abuse
- Fail-open: if safety check errors, request continues

### Output Safety
- Checks AI response before returning
- Blocks: unsafe generated content
- Returns 400 with violation details if triggered

### Rate Limiting (`safety/rate-limiter-service.ts`)
- Per-user request limits
- Configurable windows and thresholds
- Returns 429 with retry-after header

### Task Classification (`safety/task-classifier-service.ts`)
- Classifies complexity: LOW / MEDIUM / HIGH
- Used for routing and monitoring
- Included in response metadata

---

## Environment Variables

```env
# ── FREE AI PROVIDERS ────────────────────────────────────────────────────────
GROQ_API_KEY=                    # Optional; Groq $0 Free plan only
GROQ_FREE_PLAN_ONLY=false       # Set true only after confirming the Groq account is Free, not Developer
GOOGLE_API_KEY=                  # https://aistudio.google.com/app/apikey
GOOGLE_AI_API_KEY=               # Same key, used for embeddings
OPENROUTER_API_KEY=              # https://openrouter.ai/keys
CLOUDFLARE_ACCOUNT_ID=           # Cloudflare account ID
CLOUDFLARE_AI_API_TOKEN=         # Workers AI Read + Edit permissions
ENABLE_CLOUDFLARE_TEXT_AI=false  # Explicit opt-in for Cloudflare chat models

# ── SEARCH (optional, improves search quality) ────────────────────────────────
BRAVE_SEARCH_API_KEY=            # https://brave.com/search/api/ (RECOMMENDED)
SERPAPI_KEY=                     # https://serpapi.com
GNEWS_API_KEY=                   # https://gnews.io
CRICAPI_KEY=                     # https://cricapi.com
ALPHA_VANTAGE_API_KEY=           # https://alphavantage.co

# ── IMAGE GENERATION (optional) ───────────────────────────────────────────────
ENABLE_CLOUDFLARE_IMAGE_AI=false # Explicit opt-in for Cloudflare FLUX.1 schnell
CLOUDFLARE_AI_GATEWAY_ID=        # Optional AI Gateway slug

# ── MEMORY / DATABASE (optional) ──────────────────────────────────────────────
SUPABASE_URL=                    # https://supabase.com/dashboard
SUPABASE_ANON_KEY=               # Project anon key
SUPABASE_SERVICE_ROLE_KEY=       # Service role key
UPSTASH_VECTOR_REST_URL=         # https://console.upstash.com/vector
UPSTASH_VECTOR_REST_TOKEN=       # Vector REST token

# ── SERVER CONFIG ─────────────────────────────────────────────────────────────
PORT=8080
NODE_ENV=production
ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:3000
```

---

## Deployment

### Render (Recommended)

1. Connect GitHub repo
2. Set **Root Directory** to `server`
3. **Build Command:** `npm install && npm run build`
4. **Start Command:** `npm start`
5. Add all environment variables in Render dashboard
6. Set `NODE_ENV=production`

### Railway

```toml
# railway.toml
[build]
builder = "nixpacks"
buildCommand = "cd server && npm install && npm run build"

[deploy]
startCommand = "cd server && npm start"
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --only=production
COPY server/ .
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]
```

### Fly.io

```toml
# fly.toml
[build]
  dockerfile = "Dockerfile"

[[services]]
  internal_port = 8080
  protocol = "tcp"
```

---

## Future Expansion

Slots are already registered in `server.ts` (commented out). Uncomment + add handler:

| Endpoint | Description | Status |
|----------|-------------|--------|
| `POST /api/ai/code-executor` | Sandboxed code execution (Python, JS, etc.) | Planned |
| `POST /api/ai/multi-agent` | Multi-agent research pipeline | Planned |
| `POST /api/ai/vision` | Image understanding / OCR | Planned |
| `POST /api/ai/data-analyzer` | CSV / Excel analysis | Planned |
| `POST /api/voice/clone` | Voice cloning | Planned |
| `POST /api/ai/translate` | Multi-language translation | Planned |
| `POST /api/ai/embeddings` | Generate text embeddings | Planned |
| `POST /api/ai/rag` | Direct RAG pipeline endpoint | Planned |
| `POST /api/ai/agent` | Autonomous agent execution | Planned |
| `POST /api/ai/sentiment` | Sentiment analysis | Planned |

---

## Folder Structure

```
server/
├── server.ts                    ← Express entry point
├── package.json
├── tsconfig.json
├── env.example
│
├── core/                        ← The Brain
│   ├── intent-detector.ts       ← Classifies user intent
│   └── orchestrator.ts          ← Builds enriched context
│
├── adapters/                    ← AI Provider Adapters
│   ├── groq-adapter.ts
│   ├── google-adapter.ts
│   ├── cloudflare-adapter.ts
│   ├── openrouter-adapter.ts
│   ├── types.ts
│   └── index.ts
│
├── routing/                     ← Smart Routing
│   ├── smart-fallback.ts        ← Auto model switching
│   ├── multi-provider-router.ts
│   ├── auto-router.ts
│   ├── command-router.ts
│   ├── query-classifier.ts
│   ├── model-config.ts
│   └── model-registry.ts
│
├── flows/                       ← AI Pipelines
│   ├── search-pipeline.ts       ← 6-step search (Steps 5-6)
│   ├── enhanced-search.ts       ← Legacy wrapper
│   ├── enhanced-solve.ts
│   ├── enhanced-summarize.ts
│   ├── enhanced-image-solver.ts
│   ├── enhanced-pdf-analyzer.ts
│   ├── generate-answer-from-context.ts
│   ├── process-user-message.ts
│   ├── generate-image.ts
│   ├── web-search.ts
│   └── text-to-speech.ts
│
├── tools/                       ← Real-time Tools
│   ├── search-engine.ts         ← 6-step search (Steps 1-4) ← NEW
│   ├── agent-tools.ts           ← News/weather/sports/finance
│   └── duckduckgo.ts            ← DDG API client
│
├── image/                       ← Image Generation
│   ├── soham-image-pipeline.ts  ← CF → Pollinations → HF
│   └── cloudflare-ai.ts
│
├── memory/                      ← Memory Systems
│   ├── agent-memory.ts          ← Supabase + Upstash
│   ├── memory-system-service.ts ← Long-term memory
│   └── memory-extraction-service.ts
│
├── voice/                       ← Voice Processing
│   ├── unified-voice-service.ts
│   ├── groq-tts-service.ts
│   └── groq-stt-service.ts
│
├── safety/                      ← Security
│   ├── safety-guard-service.ts
│   ├── rate-limiter-service.ts
│   └── task-classifier-service.ts
│
├── routes/                      ← API Route Handlers
│   ├── chat-impl.ts             ← POST /api/chat
│   ├── chat-personality.ts      ← POST /api/chat/personality
│   ├── health.ts                ← GET /api/health
│   ├── video.ts                 ← POST /api/video/generate
│   ├── ai/
│   │   ├── search.ts            ← POST /api/ai/search
│   │   ├── solve.ts             ← POST /api/ai/solve
│   │   ├── summarize.ts         ← POST /api/ai/summarize
│   │   ├── image-solver.ts      ← POST /api/ai/image-solver
│   │   └── pdf-analyzer.ts      ← POST /api/ai/pdf-analyzer
│   ├── image/
│   │   ├── generate.ts          ← POST /api/image/generate
│   │   └── generate-cf.ts       ← POST /api/image/generate-cf
│   ├── voice/
│   │   ├── tts.ts               ← POST /api/voice/tts
│   │   └── transcribe.ts        ← POST /api/voice/transcribe
│   └── memory/
│       └── extract.ts           ← POST /api/memory/extract
│
└── docs/
    ├── SERVER_DOCS.md           ← This file
    └── SEARCH_SYSTEM.md         ← Search pipeline deep-dive
```
