/**
 * SOHAM Backend Server — Express Entry Point
 * ─────────────────────────────────────────────
 * Standalone Node.js/Express server for deployment on Render, Railway, Fly.io, etc.
 *
 * All AI intelligence lives here:
 *   POST /api/chat                  → Main chat (full orchestration)
 *   POST /api/chat/personality      → Chat with personality system
 *   POST /api/ai/search             → Web search + AI summarization
 *   POST /api/ai/solve              → Math / problem solver
 *   POST /api/ai/summarize          → Text summarization
 *   POST /api/ai/image-solver       → Solve equations from images
 *   POST /api/ai/pdf-analyzer       → Analyze PDF documents
 *   POST /api/image/generate        → Image generation (CF → Pollinations → HF)
 *   POST /api/image/generate-cf     → Cloudflare Workers AI image only
 *   POST /api/voice/tts             → Text-to-Speech (Groq Orpheus)
 *   POST /api/voice/transcribe      → Speech-to-Text (Groq Whisper)
 *   POST /api/memory/extract        → Extract & store conversation memories
 *   GET  /api/health                → Health check + provider status
 *
 * ─── Skills (v2) ──────────────────────────────────────────────────────────────
 *   POST /api/ai/translate          → Multi-language translation (auto-detect source)
 *   POST /api/ai/sentiment          → Sentiment + emotion analysis
 *   POST /api/ai/classify           → Text classification (custom or auto categories)
 *   POST /api/ai/grammar            → Grammar correction & writing improvement
 *   POST /api/ai/quiz               → Quiz / flashcard generator
 *   POST /api/ai/recipe             → Recipe generator from ingredients / cuisine
 *   POST /api/ai/joke               → Joke / pun / roast / riddle / fun-fact generator
 *   POST /api/ai/dictionary         → Word definitions, synonyms, etymology
 *   POST /api/ai/fact-check         → Fact-checking with web search + AI reasoning
 ──────────────────────────────────────────────────────────────────────────────
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load .env from either the source root or the compiled dist directory.
const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '.env.local'),
];

const loadedEnvPath = envCandidates.find(candidate => fs.existsSync(candidate));

if (loadedEnvPath) {
  if (loadedEnvPath.endsWith('.env.local') && !loadedEnvPath.includes(`${path.sep}dist${path.sep}`)) {
    console.log('📝 .env not found, loading from .env.local');
  }
  dotenv.config({ path: loadedEnvPath });
} else {
  console.warn('⚠️ No .env or .env.local found! Providers may fail.');
}

import express from 'express';
import cors from 'cors';
import { json } from 'express';

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
// ── Skills v2 ──────────────────────────────────────────────────────────────────
import { translateHandler } from './routes/ai/translate';
import { sentimentHandler } from './routes/ai/sentiment';
import { classifyHandler } from './routes/ai/classify';
import { grammarHandler } from './routes/ai/grammar';
import { quizHandler } from './routes/ai/quiz';
import { recipeHandler } from './routes/ai/recipe';
import { jokeHandler } from './routes/ai/joke';
import { dictionaryHandler } from './routes/ai/dictionary';
import { factCheckHandler } from './routes/ai/fact-check';

const app = express();
const PORT = process.env.PORT || 8080;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(json({ limit: '50mb' })); // Large limit for PDF/image uploads

// ── Security Middleware ────────────────────────────────────────────────────────
const SOHAM_API_KEY = process.env.SOHAM_API_KEY || 'soham-secret-key-2025';

app.use('/api', (req, res, next) => {
  // Allow health check without API key for monitoring uptime
  // req.path is relative to the mount point '/api'
  if (req.path === '/health' || req.path === '/health/') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SOHAM_API_KEY}`) {
    console.warn(`🚨 [Security] Unauthorized ${req.method} attempt to ${req.originalUrl} from ${req.ip}`);
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid API key in Authorization header. Use "Authorization: Bearer <YOUR_SOHAM_API_KEY>"',
    });
  }
  next();
});

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'soham-backend-server',
    health: '/api/health',
  });
});

app.get('/api/health', healthHandler);

// ── Chat ───────────────────────────────────────────────────────────────────────
app.post('/api/chat', chatHandler);
app.post('/api/chat/personality', chatPersonalityHandler);

// ── AI Tools ───────────────────────────────────────────────────────────────────
app.post('/api/ai/search', searchHandler);
app.post('/api/ai/solve', solveHandler);
app.post('/api/ai/summarize', summarizeHandler);
app.post('/api/ai/image-solver', imageSolverHandler);
app.post('/api/ai/pdf-analyzer', pdfAnalyzerHandler);

// ── Image Generation ───────────────────────────────────────────────────────────
app.post('/api/image/generate', generateImageHandler);
app.post('/api/image/generate-cf', generateImageCFHandler);

// ── Voice ──────────────────────────────────────────────────────────────────────
app.post('/api/voice/tts', ttsHandler);
app.post('/api/voice/transcribe', transcribeHandler);

// ── Memory ─────────────────────────────────────────────────────────────────────
app.post('/api/memory/extract', extractMemoriesHandler);

// ── User Profile ───────────────────────────────────────────────────────────────
app.get('/api/memory/profile/:userId', getProfileHandler);
app.post('/api/memory/profile/:userId', upsertProfileHandler);
app.delete('/api/memory/profile/:userId', deleteProfileHandler);

// ── Public Knowledge (Upstash Vector) ─────────────────────────────────────────
app.post('/api/memory/knowledge', storeKnowledgeHandler);
app.post('/api/memory/knowledge/search', searchKnowledgeHandler);
app.post('/api/memory/knowledge/correction', storeCorrectionHandler);
app.post('/api/memory/knowledge/suggestion', storeSuggestionHandler);

// ── Skills v2 ──────────────────────────────────────────────────────────────────
app.post('/api/ai/translate', translateHandler);
app.post('/api/ai/sentiment', sentimentHandler);
app.post('/api/ai/classify', classifyHandler);
app.post('/api/ai/grammar', grammarHandler);
app.post('/api/ai/quiz', quizHandler);
app.post('/api/ai/recipe', recipeHandler);
app.post('/api/ai/joke', jokeHandler);
app.post('/api/ai/dictionary', dictionaryHandler);
app.post('/api/ai/fact-check', factCheckHandler);

// app.post('/api/ai/agent', agentHandler);

// ── Future Expansion Slots (uncomment when ready) ─────────────────────────────
// app.post('/api/ai/code-executor', codeExecutorHandler);
// app.post('/api/ai/multi-agent', multiAgentHandler);
// app.post('/api/ai/vision', visionHandler);
// app.post('/api/ai/data-analyzer', dataAnalyzerHandler);
// app.post('/api/voice/clone', voiceCloneHandler);
// app.post('/api/ai/embeddings', embeddingsHandler);
// app.post('/api/ai/rag', ragHandler);
// app.post('/api/ai/agent', agentHandler);

// ── 404 fallback ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Endpoint ${req.method} ${req.path} not found`,
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

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SOHAM Backend Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Chat:   http://localhost:${PORT}/api/chat`);
});

export default app;
