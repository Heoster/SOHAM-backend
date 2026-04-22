/**
 * POST /api/chat
 * ──────────────
 * Main SOHAM chat endpoint — full orchestration pipeline:
 *   Safety check → Task classification → Tool execution →
 *   RAG context → Smart fallback AI → Memory persist
 *
 * Body:
 *   message        string   (required)
 *   history        array    (optional) [{ role: 'user'|'assistant', content: string }]
 *   settings       object   (optional) { model, tone, technicalLevel }
 *   userId         string   (optional) for memory + cross-device history
 *
 * Response:
 *   { success, content, modelUsed, autoRouted, classification, toolsUsed, responseTime }
 */

// NOTE: This file is a copy of src/app/api/chat-direct/route.ts
// adapted for Express. The full implementation is in routes/chat.ts (copied from Next.js route).
// When running as standalone Express server, replace NextRequest/NextResponse with req/res.

export { } from './chat-impl';

// Re-export the handler for server.ts
export { chatHandler } from './chat-impl';
