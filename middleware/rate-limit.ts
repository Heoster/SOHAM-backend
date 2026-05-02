/**
 * Per-IP Rate Limiter Middleware
 * In-memory sliding window rate limiter — no Redis dependency.
 * Suitable for single-instance deployments (Render free tier).
 *
 * Limits:
 *   /api/chat*          → 20 req / min per IP  (AI generation is expensive)
 *   /api/ai/*           → 30 req / min per IP
 *   /api/image/*        → 10 req / min per IP  (image gen is very expensive)
 *   /api/voice/*        → 20 req / min per IP
 *   /api/memory/*       → 60 req / min per IP
 *   All other /api/*    → 60 req / min per IP
 *
 * Returns 429 with Retry-After header when limit is exceeded.
 * Automatically cleans up stale entries every 5 minutes.
 */

import type { Request, Response, NextFunction } from 'express';

interface WindowEntry {
  timestamps: number[];
  blocked: number;
}

const store = new Map<string, WindowEntry>();
const WINDOW_MS = 60_000; // 1 minute sliding window

// Clean up stale entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of store.entries()) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 5 * 60_000).unref(); // .unref() so this timer doesn't prevent process exit

function getLimit(path: string): number {
  if (path.startsWith('/chat'))   return 20;
  if (path.startsWith('/image'))  return 10;
  if (path.startsWith('/voice'))  return 20;
  if (path.startsWith('/ai'))     return 30;
  if (path.startsWith('/memory')) return 60;
  return 60;
}

function getClientKey(req: Request, path: string): string {
  const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  return `${ip}:${path.split('/')[1] ?? 'root'}`;
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting for health checks
  if (req.path === '/health' || req.path === '/health/') {
    next();
    return;
  }

  const limit = getLimit(req.path);
  const key   = getClientKey(req, req.path);
  const now   = Date.now();
  const cutoff = now - WINDOW_MS;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [], blocked: 0 };
    store.set(key, entry);
  }

  // Slide the window
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= limit) {
    entry.blocked++;
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs   = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);

    res.setHeader('Retry-After', String(retryAfterMs));
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + retryAfterMs * 1000) / 1000)));

    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Please wait ${retryAfterMs} second(s) before retrying.`,
      retryAfterSeconds: retryAfterMs,
    });
    return;
  }

  entry.timestamps.push(now);

  // Expose rate limit headers on every response
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(limit - entry.timestamps.length));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + WINDOW_MS) / 1000)));

  next();
}
