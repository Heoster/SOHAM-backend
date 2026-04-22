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
│                    │   Groq → Cerebras →      │                  │
│                    │   Google → HuggingFace   │                  │
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
# Edit .env — at minimum set GROQ_API_KEY

# 3. Run in development
npm run dev

# 4. Test health
curl http://localhost:8080/api/health
```

**Minimum requirement:** Only `GROQ_API_KEY` is required. Everything else degrades gracefully.

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
| POST | `/api/image/generate` | Full pipeline: CF → Pollinations → HuggingFace |
| POST | `/api/image/generate-cf` | Cloudflare Workers AI only |
| GET | `/api/image/generate-cf` | Health check for CF image provider |

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
  "modelUsed": "llama-3.1-8b-instant",
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
  "preferredModel": "llama-3.1-8b-instant",
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
  "modelUsed": "llama-3.1-8b-instant",
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
  "preferredModel": "llama-3.3-70b-versatile"
}
```

---

### `POST /api/ai/summarize`

**Request:**
```json
{
  "text": "Long article text here...",
  "style": "bullets",
  "preferredModel": "llama-3.1-8b-instant"
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

## AI Model Providers

### Provider Priority (Smart Fallback)

```
Groq (primary — fastest)
    ↓ fails
Cerebras (fast fallback)
    ↓ fails
Google Gemini (reliable fallback)
    ↓ fails
HuggingFace Router (free fallback)
    ↓ fails
OpenRouter (multi-model gateway)
```

### Available Models

| Provider | Models | Speed | Free |
|----------|--------|-------|------|
| Groq | llama-3.1-8b, llama-3.3-70b, mixtral-8x7b, gemma2-9b | ⚡⚡⚡ | ✅ |
| Cerebras | llama-3.1-8b, llama-3.3-70b | ⚡⚡⚡ | ✅ |
| Google | gemini-1.5-flash, gemini-1.5-pro | ⚡⚡ | ✅ (limited) |
| HuggingFace | FLUX.1-schnell, various LLMs | ⚡ | ✅ |
| OpenRouter | 100+ models | varies | some free |

### Model Selection

- `"model": "auto"` → Auto-router picks best model for query type
- `"model": "llama-3.1-8b-instant"` → Use specific model with fallback
- Smart fallback automatically switches on failure (rate limit, timeout, error)

---

## Search System

See [SEARCH_SYSTEM.md](./SEARCH_SYSTEM.md) for complete documentation.

**Quick summary:**
- 6-step pipeline: Analysis → Source Selection → Parallel Fetch → Merge → AI Synthesis → Citations
- Sources: Brave, SerpAPI, GNews, Wikipedia, DuckDuckGo, Open-Meteo, CoinGecko, CricAPI
- Works with zero API keys (DuckDuckGo + Wikipedia always available)
- Best with `BRAVE_SEARCH_API_KEY` configured

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
1. Cloudflare Workers AI (flux-1-schnell)
   Needs: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_API_TOKEN
   Speed: ~3s | Quality: ⭐⭐⭐⭐⭐
       ↓ fails
2. Pollinations.ai (FLUX)
   Needs: nothing (free)
   Speed: ~1.6s | Quality: ⭐⭐⭐⭐
       ↓ fails
3. HuggingFace Router (FLUX.1-schnell)
   Needs: HUGGINGFACE_API_KEY
   Speed: ~7s | Quality: ⭐⭐⭐⭐⭐
```

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
# ── REQUIRED ──────────────────────────────────────────────────────────────────
GROQ_API_KEY=                    # https://console.groq.com/keys

# ── AI PROVIDERS (optional, improves quality) ─────────────────────────────────
GOOGLE_API_KEY=                  # https://aistudio.google.com/app/apikey
GOOGLE_AI_API_KEY=               # Same key, used for embeddings
CEREBRAS_API_KEY=                # https://cloud.cerebras.ai
HUGGINGFACE_API_KEY=             # https://huggingface.co/settings/tokens
OPENROUTER_API_KEY=              # https://openrouter.ai/keys

# ── SEARCH (optional, improves search quality) ────────────────────────────────
BRAVE_SEARCH_API_KEY=            # https://brave.com/search/api/ (RECOMMENDED)
SERPAPI_KEY=                     # https://serpapi.com
GNEWS_API_KEY=                   # https://gnews.io
CRICAPI_KEY=                     # https://cricapi.com
ALPHA_VANTAGE_API_KEY=           # https://alphavantage.co

# ── IMAGE GENERATION (optional) ───────────────────────────────────────────────
CLOUDFLARE_ACCOUNT_ID=           # Cloudflare dashboard
CLOUDFLARE_AI_API_TOKEN=         # Workers AI:Edit permission
CLOUDFLARE_AI_GATEWAY_ID=        # Optional: AI Gateway for caching

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
│   ├── cerebras-adapter.ts
│   ├── google-adapter.ts
│   ├── huggingface-adapter.ts
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
