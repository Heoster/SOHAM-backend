/**
 * Per-IP Rate Limiter Middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory sliding window rate limiter — no Redis dependency.
 * Suitable for single-instance deployments (Render free tier).
 *
 * Limits (per IP per minute):
 *   /api/chat*    → 20   (AI generation is expensive)
 *   /api/ai/*     → 30
 *   /api/image/*  → 10   (image gen is very expensive)
 *   /api/voice/*  → 20
 *   /api/memory/* → 60
 *   everything else → 60
 *
 * Memory safety:
 *   - Hard cap of MAX_STORE_SIZE entries (LRU eviction when full)
 *   - Stale entries cleaned every 5 minutes
 *
 * Returns 429 with Retry-After header when limit is exceeded.
 */

import type { Request, Response, NextFunction } from 'express';

interface WindowEntry {
  timestamps: number[];
  blocked: number;
  lastSeen: number;
}

const WINDOW_MS      = 60_000;   // 1 minute sliding window
const MAX_STORE_SIZE = 10_000;   // max unique IPs tracked — prevents unbounded growth

const store = new Map<string, WindowEntry>();

// ── LRU eviction helper ───────────────────────────────────────────────────────
function evictOldest(): void {
  // Map preserves insertion order — first entry is oldest
  const firstKey = store.keys().next().value;
  if (firstKey !== undefined) store.delete(firstKey);
}

// ── Periodic cleanup — remove fully-expired entries ──────────────────────────
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of store.entries()) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 5 * 60_000).unref();

// ── Limit table ───────────────────────────────────────────────────────────────
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
  // Bucket by IP + top-level path segment (e.g. "chat", "ai", "memory")
  return `${ip}:${path.split('/')[1] ?? 'root'}`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health' || req.path === '/health/') {
    next();
    return;
  }

  const limit  = getLimit(req.path);
  const key    = getClientKey(req, req.path);
  const now    = Date.now();
  const cutoff = now - WINDOW_MS;

  // Get or create entry
  let entry = store.get(key);
  if (!entry) {
    // Evict oldest if at capacity before inserting
    if (store.size >= MAX_STORE_SIZE) evictOldest();
    entry = { timestamps: [], blocked: 0, lastSeen: now };
    store.set(key, entry);
  } else {
    // Move to end (most-recently-used) by re-inserting
    store.delete(key);
    store.set(key, entry);
  }

  entry.lastSeen = now;
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= limit) {
    entry.blocked++;
    const oldestInWindow = entry.timestamps[0];
    const retryAfterSec  = Math.max(1, Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000));

    res.setHeader('Retry-After',          String(retryAfterSec));
    res.setHeader('X-RateLimit-Limit',    String(limit));
    res.setHeader('X-RateLimit-Remaining','0');
    res.setHeader('X-RateLimit-Reset',    String(Math.ceil((now + retryAfterSec * 1000) / 1000)));

    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Please wait ${retryAfterSec} second(s) before retrying.`,
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }

  entry.timestamps.push(now);

  res.setHeader('X-RateLimit-Limit',    String(limit));
  res.setHeader('X-RateLimit-Remaining',String(limit - entry.timestamps.length));
  res.setHeader('X-RateLimit-Reset',    String(Math.ceil((now + WINDOW_MS) / 1000)));

  next();
}
