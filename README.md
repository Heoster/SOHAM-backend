# SOHAM Backend Server
> **Self Organising Hyper Adaptive Machine** — the intelligence layer of CODEEX-AI.

SOHAM is a Node.js/Express backend for chat, AI orchestration, tools, search, memory, and multimodal processing.

## Quick start

```bash
npm install
cp env.example .env
# Set at least one provider credential, then:
npm run dev
```

Chat routing uses free-tier Google Gemini models and OpenRouter’s free router. Groq GPT-OSS 120B, GPT-OSS 20B, and Qwen 3.8 27B are also supported, but Groq routing is disabled unless `GROQ_FREE_PLAN_ONLY=true` confirms the key belongs to Groq’s $0 Free plan. Cloudflare Workers AI chat is supported with Granite 4.0 H Micro and GPT-OSS 20B, but is disabled unless `ENABLE_CLOUDFLARE_TEXT_AI=true`; Cloudflare usage shares account-level Neuron quota and may be billed beyond the free allocation. Configure:

- `GOOGLE_API_KEY` and/or `OPENROUTER_API_KEY`
- `GROQ_API_KEY` plus `GROQ_FREE_PLAN_ONLY=true` only for a confirmed Groq Free-plan account
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_API_TOKEN` + `ENABLE_CLOUDFLARE_TEXT_AI=true` to opt in to Cloudflare chat

OpenRouter uses its `openrouter/free` dynamic router rather than a fixed free model ID. This avoids pinning fallback to a model that a provider has retired or temporarily disabled. If a provider rate limit is exhausted, routing falls back only to another enabled catalog model; no paid model fallback is configured. Google free-tier access and provider quotas are subject to the provider’s current terms.

## Security

All API endpoints except `/api/health` are protected by the shared backend API key. Send it as:

```http
Authorization: Bearer <SOHAM_API_KEY>
```

Set a unique `SOHAM_API_KEY` in production. The development default in `server.ts` should not be used in deployment.

Groq tooling is explicit per request. For GPT-OSS built-ins, set `settings.groqBuiltinTools` to `browser_search` and/or `code_interpreter`; to use SOHAM's allowlisted local tools (web/news/GNews, weather, sports, finance) with GPT-OSS or Qwen, set `settings.enableLocalToolCalling: true`. These require the Groq Free-plan gate above.

Health probes are quota-aware: `/api/health/live` and `/api/health/ready` make no provider requests. Deep `/api/health?probe=1` requires `Authorization: Bearer $SOHAM_API_KEY` and may consume API quota.

## Build and run

```bash
npm run build
npm start
```

## CI/CD

GitHub Actions runs `npm ci`, TypeScript typechecking, the production build, and mocked Cloudflare integration tests on pushes and pull requests. The Render Blueprint sets `autoDeployTrigger: checksPass`, so the linked SOHAM web service deploys changes only after repository CI checks pass. Keep the Render service linked to the `main` branch and sync the Blueprint in Render for this deployment policy to take effect.

## Main endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Full system, model catalog, and integration report |
| `/api/health/live` | `GET` | Process liveness |
| `/api/health/ready` | `GET` | Model-provider readiness |
| `/api/health/services` | `GET` | Search/domain service inventory |
| `/api/chat` | `POST` | Chat with orchestration and memory |
| `/api/chat/stream` | `POST` | SSE chat with provider fallback |
| `/api/ai/search` | `POST` | Web search (Tavily + Firecrawl) |
| `/api/ai/solve` | `POST` | Math and logic problem solver |
| `/api/ai/pdf-analyzer` | `POST` | Multimodal PDF analysis |
| `/api/image/generate` | `POST` | Opt-in Cloudflare image generation, falling back to Pollinations |
| `/api/image/generate-cf` | `POST` | Cloudflare FLUX.1 schnell image generation (explicit opt-in) |
| `/api/image/generate-cf` | `GET` | Cloudflare image capability/configuration (no generation) |
| `/api/voice/tts` | `POST` | Browser text-to-speech fallback |

## Architecture

- **Adapters** (`adapters/`): provider-specific Groq, Google Gemini, OpenRouter, and Cloudflare Workers AI clients.
- **Model registry** (`routing/model-registry.ts`): curated, enabled model catalog plus environment-based provider availability.
- **Auto-router** (`routing/auto-router.ts`): intent-aware model preferences generated from the live registry, not hard-coded provider lists.
- **Smart fallback** (`routing/smart-fallback.ts`): cross-provider fallback, model circuit breakers, context checks, and safe streaming failover (only before output starts).
- **Memory** (`memory/`): Supabase history and semantic retrieval.

The Google Gemini adapter supports multimodal messages and base64 image/PDF data URIs. Cloudflare Workers AI image generation uses the documented FLUX.1 schnell model and is disabled by default; set `ENABLE_CLOUDFLARE_IMAGE_AI=true` to opt in. Text and image gates are independent. Cloudflare currently documents 10,000 Neurons/day at no charge across Workers AI, with paid usage beyond that allocation on Workers Paid; check the dashboard and current pricing because this is an account-wide quota, not a SOHAM billing cap. Image cost depends on tiles and inference steps.
