# SOHAM Backend Server
> **Self Organising Hyper Adaptive Machine** — The intelligence layer of CODEEX-AI

This directory contains the independent Node.js/Express server for SOHAM AI. It handles the complete AI orchestration pipeline, tool execution, search, memory, and multimodal processing.

## 🚀 Quick Start (Independent)

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Copy `.env.local` to `.env` (or use `.env.local` directly):
   ```bash
   cp .env.local .env
   ```
   *Required: `GROQ_API_KEY`*
   *Optional: `GOOGLE_API_KEY`, `TAVILY_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, etc.*

3. **Run in Development**:
   ```bash
   npm run dev
   ```

## 🔒 Security

All API endpoints (except `/api/health`) are protected by an API Key.
To access them, include the following header in your requests:

```http
Authorization: Bearer <YOUR_SOHAM_API_KEY>
```

Default key (if not set in env): `soham-secret-key-2025`.

4. **Build & Start for Production**:
   ```bash
   npm run build
   npm start
   ```

### Render Deployment

- Use [render.yaml](/D:/SOHAM%20main/server/render.yaml) for a web service blueprint.
- Set `SOHAM_API_KEY` to the same value used by the Vercel UI app.
- Set `ALLOWED_ORIGINS` to your Vercel domain, for example `https://your-frontend.vercel.app`.

## 🛠️ Key Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | System health & provider connectivity |
| `/api/chat` | `POST` | Main chat with orchestration & memory |
| `/api/ai/search` | `POST` | Smart web search (Tavily + Firecrawl) |
| `/api/ai/solve` | `POST` | Math & logic problem solver |
| `/api/ai/pdf-analyzer` | `POST` | Multimodal PDF analysis |
| `/api/image/generate` | `POST` | FLUX image generation with fallbacks |
| `/api/voice/tts` | `POST` | Text-to-Speech (Groq Orpheus) |

## 🧬 Architecture

- **Orchestrator**: `core/orchestrator.ts` — Coordinates tools, RAG context, and memory.
- **Adapters**: `adapters/` — Unified interface for Groq, Google, Cerebras, HF, and OpenRouter.
- **Smart Fallback**: `routing/smart-fallback.ts` — Auto-switches models on failure.
- **Skills v2**: `flows/` — Specialized tools (Translate, Quiz, Recipe, Grammar, etc.).
- **Memory**: `memory/` — Cross-device history (Supabase) and semantic RAG (Upstash).

## 🛡️ Multimodal Support
The server now natively supports base64 data URIs for Images and PDFs when using the Google Gemini provider. The logic in `adapters/google-adapter.ts` automatically detects and converts these URIs into multimodal parts.

---
Created by **Heoster** (@CODEEX-AI)
