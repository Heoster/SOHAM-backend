/**
 * SOHAM Backend Server — Production Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * Production hardening applied:
 *   ✅ Request ID / correlation ID on every request
 *   ✅ Security headers (X-Content-Type-Options, CSP, HSTS, etc.)
 *   ✅ Per-IP rate limiting on all AI endpoints
 *   ✅ Tightened body size limits (10MB default, 20MB for PDF/image routes)
 *   ✅ Structured JSON logging (replaces console.log)
 *   ✅ Graceful shutdown on SIGTERM / SIGINT
 *   ✅ Global JSON error handler (no HTML 500 pages)
 *   ✅ 405 Method Not Allowed handler
 *   ✅ Request timeout (60s default, 120s for heavy routes)
 *   ✅ Unhandled rejection / uncaught exception handlers
 *   ✅ SOHAM_API_KEY required — no hardcoded fallback
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

// ── Load env before anything else ─────────────────────────────────────────────
const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '.env.local'),
];
const loadedEnvPath = envCandidates.find(c => fs.existsSync(c));
if (loadedEnvPath) {
  dotenv.config({ path: loadedEnvPath });
} else {
  process.stderr.write('⚠️  No .env or .env.local found — providers may fail.\n');
}

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { json, urlencoded } from 'express';
import { logger } from './utils/logger';
import { requestIdMiddleware } from './middleware/request-id';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { rateLimitMiddleware } from './middleware/rate-limit';

// ── Route handlers ─────────────────────────────────────────────────────────────
import { chatHandler } from './routes/chat';
import { chatPersonalityHandler } from './routes/chat-personality';
import { searchHandler } from './routes/ai/search';
import { solveHandler } from './routes/ai/solve';
import { summarizeHandler } from './routes/ai/summarize';
import { imageSolverHandler } from './routes/ai/image-solver';
import { pdfAnalyzerHandler } from './routes/ai/pdf-analyzer';
import { generateImageHandler } from './routes/image/generate';
import { generateImageCFHandler } from './routes/image/generate-cf';
import { ttsHandler } from './routes/voice/tts';
import { transcribeHandler } from './routes/voice/transcribe';
import { extractMemoriesHandler } from './routes/memory/extract';
import { getProfileHandler, upsertProfileHandler, deleteProfileHandler } from './routes/memory/profile';
import {
  storeKnowledgeHandler,
  searchKnowledgeHandler,
  storeCorrectionHandler,
  storeSuggestionHandler,
} from './routes/memory/knowledge';
import { healthHandler } from './routes/health';
import { translateHandler } from './routes/ai/translate';
import { sentimentHandler } from './routes/ai/sentiment';
import { classifyHandler } from './routes/ai/classify';
import { grammarHandler } from './routes/ai/grammar';
import { quizHandler } from './routes/ai/quiz';
import { recipeHandler } from './routes/ai/recipe';
import { jokeHandler } from './routes/ai/joke';
import { dictionaryHandler } from './routes/ai/dictionary';
import { factCheckHandler } from './routes/ai/fact-check';

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT ?? '8080', 10);
const isProd      = process.env.NODE_ENV === 'production';
const SOHAM_API_KEY = process.env.SOHAM_API_KEY;

if (!SOHAM_API_KEY) {
  const msg = 'SOHAM_API_KEY is not set — all /api requests will be rejected.';
  isProd ? logger.error(msg) : logger.warn(msg);
}

// ── CORS origins ───────────────────────────────────────────────────────────────
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
);
if (process.env.RENDER_EXTERNAL_URL) {
  allowedOrigins.add(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ''));
}

// ── Timeout helper ─────────────────────────────────────────────────────────────
/**
 * Wraps a route handler with a hard timeout.
 * If the handler doesn't respond within `ms`, returns 504.
 */
function withTimeout(handler: express.RequestHandler, ms: number): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn('Request timeout', { path: req.path, ms, requestId: req.requestId });
        res.status(504).json({
          error: 'GATEWAY_TIMEOUT',
          message: `Request timed out after ${ms / 1000}s. Please try again.`,
          requestId: req.requestId,
        });
      }
    }, ms);

    // Clear timer when response finishes
    res.on('finish', () => clearTimeout(timer));
    res.on('close',  () => clearTimeout(timer));

    handler(req, res, next);
  };
}

// ── App ────────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by'); // Don't advertise Express

// ── Global middleware ──────────────────────────────────────────────────────────
app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);

// ── CORS ───────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.size === 0 || allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked', { origin });
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: true,
}));

// ── Body parsers — tight limits by default ─────────────────────────────────────
// PDF/image routes override this with a larger limit via their own middleware
app.use((req, res, next) => {
  const heavyRoutes = ['/api/ai/pdf-analyzer', '/api/ai/image-solver', '/api/image/'];
  const isHeavy = heavyRoutes.some(r => req.path.startsWith(r));
  json({ limit: isHeavy ? '20mb' : '1mb' })(req, res, next);
});
app.use(urlencoded({ extended: false, limit: '1mb' }));

// ── Request logging ────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info('→ request', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    requestId: req.requestId,
  });
  next();
});

// ── Auth middleware ────────────────────────────────────────────────────────────
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health' || req.path === '/health/') return next();

  const authHeader = req.headers.authorization;
  if (!SOHAM_API_KEY || !authHeader || authHeader !== `Bearer ${SOHAM_API_KEY}`) {
    logger.warn('Unauthorized request', {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      requestId: req.requestId,
    });
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid API key. Use "Authorization: Bearer <YOUR_SOHAM_API_KEY>"',
      requestId: req.requestId,
    });
    return;
  }
  next();
});

// ── Rate limiting on all /api routes ──────────────────────────────────────────
app.use('/api', rateLimitMiddleware);

// ── Root ───────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'soham-backend-server', health: '/api/health' });
});

// ── Health (no auth, no rate limit, no timeout) ────────────────────────────────
app.get('/api/health', healthHandler);

// ── Chat (60s timeout) ─────────────────────────────────────────────────────────
app.post('/api/chat',             withTimeout(chatHandler,            60_000));
app.post('/api/chat/personality', withTimeout(chatPersonalityHandler, 60_000));

// ── AI Tools (60s timeout) ────────────────────────────────────────────────────
app.post('/api/ai/search',       withTimeout(searchHandler,      60_000));
app.post('/api/ai/solve',        withTimeout(solveHandler,       60_000));
app.post('/api/ai/summarize',    withTimeout(summarizeHandler,   60_000));
app.post('/api/ai/translate',    withTimeout(translateHandler,   30_000));
app.post('/api/ai/sentiment',    withTimeout(sentimentHandler,   30_000));
app.post('/api/ai/classify',     withTimeout(classifyHandler,    30_000));
app.post('/api/ai/grammar',      withTimeout(grammarHandler,     30_000));
app.post('/api/ai/quiz',         withTimeout(quizHandler,        45_000));
app.post('/api/ai/recipe',       withTimeout(recipeHandler,      45_000));
app.post('/api/ai/joke',         withTimeout(jokeHandler,        20_000));
app.post('/api/ai/dictionary',   withTimeout(dictionaryHandler,  20_000));
app.post('/api/ai/fact-check',   withTimeout(factCheckHandler,   60_000));

// ── Heavy routes (120s timeout — PDF/image processing) ────────────────────────
app.post('/api/ai/image-solver', withTimeout(imageSolverHandler,  120_000));
app.post('/api/ai/pdf-analyzer', withTimeout(pdfAnalyzerHandler,  120_000));

// ── Image Generation (90s timeout) ────────────────────────────────────────────
app.post('/api/image/generate',    withTimeout(generateImageHandler,   90_000));
app.post('/api/image/generate-cf', withTimeout(generateImageCFHandler, 90_000));

// ── Voice (60s timeout) ───────────────────────────────────────────────────────
app.post('/api/voice/tts',        withTimeout(ttsHandler,        60_000));
app.post('/api/voice/transcribe', withTimeout(transcribeHandler, 60_000));

// ── Memory ────────────────────────────────────────────────────────────────────
app.post('/api/memory/extract',                extractMemoriesHandler);
app.get('/api/memory/profile/:userId',         getProfileHandler);
app.post('/api/memory/profile/:userId',        upsertProfileHandler);
app.delete('/api/memory/profile/:userId',      deleteProfileHandler);
app.post('/api/memory/knowledge',              storeKnowledgeHandler);
app.post('/api/memory/knowledge/search',       searchKnowledgeHandler);
app.post('/api/memory/knowledge/correction',   storeCorrectionHandler);
app.post('/api/memory/knowledge/suggestion',   storeSuggestionHandler);

// ── 405 Method Not Allowed ────────────────────────────────────────────────────
// Catches requests to known paths with the wrong HTTP method
const knownPaths = new Set([
  '/api/health', '/api/chat', '/api/chat/personality',
  '/api/ai/search', '/api/ai/solve', '/api/ai/summarize',
  '/api/ai/image-solver', '/api/ai/pdf-analyzer',
  '/api/ai/translate', '/api/ai/sentiment', '/api/ai/classify',
  '/api/ai/grammar', '/api/ai/quiz', '/api/ai/recipe',
  '/api/ai/joke', '/api/ai/dictionary', '/api/ai/fact-check',
  '/api/image/generate', '/api/image/generate-cf',
  '/api/voice/tts', '/api/voice/transcribe',
  '/api/memory/extract', '/api/memory/knowledge',
  '/api/memory/knowledge/search', '/api/memory/knowledge/correction',
  '/api/memory/knowledge/suggestion',
]);

app.use((req: Request, res: Response, next: NextFunction) => {
  // Strip dynamic segments like :userId for matching
  const staticPath = req.path.replace(/\/[^/]+$/, '/:id');
  if (knownPaths.has(req.path) || knownPaths.has(staticPath)) {
    res.status(405).json({
      error: 'METHOD_NOT_ALLOWED',
      message: `${req.method} is not allowed on ${req.path}`,
      requestId: req.requestId,
    });
    return;
  }
  next();
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Endpoint ${req.method} ${req.path} not found`,
    requestId: req.requestId,
    availableEndpoints: [
      'GET  /api/health',
      'POST /api/chat',
      'POST /api/chat/personality',
      'POST /api/ai/search',
      'POST /api/ai/solve',
      'POST /api/ai/summarize',
      'POST /api/ai/image-solver',
      'POST /api/ai/pdf-analyzer',
      'POST /api/ai/translate',
      'POST /api/ai/sentiment',
      'POST /api/ai/classify',
      'POST /api/ai/grammar',
      'POST /api/ai/quiz',
      'POST /api/ai/recipe',
      'POST /api/ai/joke',
      'POST /api/ai/dictionary',
      'POST /api/ai/fact-check',
      'POST /api/image/generate',
      'POST /api/image/generate-cf',
      'POST /api/voice/tts',
      'POST /api/voice/transcribe',
      'POST /api/memory/extract',
      'GET  /api/memory/profile/:userId',
      'POST /api/memory/profile/:userId',
      'DELETE /api/memory/profile/:userId',
      'POST /api/memory/knowledge',
      'POST /api/memory/knowledge/search',
      'POST /api/memory/knowledge/correction',
      'POST /api/memory/knowledge/suggestion',
    ],
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Unhandled route error', {
    path: req.path,
    method: req.method,
    requestId: req.requestId,
    error: message,
    // Only include stack in development
    ...(isProd ? {} : { stack: err instanceof Error ? err.stack : undefined }),
  });

  if (!res.headersSent) {
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      // Never leak internal error details in production
      message: isProd ? 'An internal error occurred. Please try again.' : message,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }
});

// ── Process-level error handlers ──────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  // Give the logger time to flush, then exit
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  // Don't exit — log and continue
});

// ── Start server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(PORT, () => {
  logger.info('SOHAM backend started', {
    port: PORT,
    env: process.env.NODE_ENV ?? 'development',
    apiKeySet: !!SOHAM_API_KEY,
    allowedOrigins: allowedOrigins.size > 0 ? [...allowedOrigins] : ['*'],
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal: string): void {
  logger.info(`${signal} received — shutting down gracefully`);

  server.close((err) => {
    if (err) {
      logger.error('Error during shutdown', { error: err.message });
      process.exit(1);
    }
    logger.info('Server closed — process exiting');
    process.exit(0);
  });

  // Force exit after 15s if connections don't drain
  setTimeout(() => {
    logger.error('Forced shutdown after 15s timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

export default app;
