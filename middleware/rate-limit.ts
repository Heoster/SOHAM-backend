/**
 * Rate Limit Middleware — distributed when configured, in-memory otherwise
 * ─────────────────────────────────────────────────────────────────────────
 * Two backends, identical response contract:
 *
 *   1. UPSTASH REDIS (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 *      → sliding-window counters in Upstash Redis, shared across EVERY
 *        instance behind your load balancer. Required for multi-instance
 *        deployments; without it each instance enforces its own limit and
 *        the effective limit is multiplied by the instance count.
 *      → Any Redis error or a >1.5s stall falls back to in-memory for that
 *        request (fail-open to availability, logged).
 *
 *   2. IN-MEMORY (default, no env needed)
 *      → per-process sliding window with LRU cap. Correct for single
 *        instance (Render free tier). NOT shared across instances.
 *
 * Limits (per client per minute) — same table for both backends:
 *   /api/chat*    → 20   (AI generation is expensive)
 *   /api/ai/*     → 30
 *   /api/image/*  → 10   (image gen is very expensive)
 *   /api/voice/*  → 20
 *   /api/memory/* → 60
 *   everything else → 60
 *
 * Client key: IP + top-level path segment. IPv4-mapped IPv6 normalized.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

const WINDOW_SECONDS = 60;
const REDIS_TIMEOUT_MS = 1_500;

// ── Limit table ─────────────────────────────────────────────────────────────
function getLimit(path: string): number {
  if (path.startsWith('/chat'))   return 20;
  if (path.startsWith('/image'))  return 10;
  if (path.startsWith('/voice'))  return 20;
  if (path.startsWith('/ai'))     return 30;
  if (path.startsWith('/memory')) return 60;
  return 60;
}

function getClientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function bucketFor(path: string): string {
  return path.split('/')[1] ?? 'root';
}

function clientKey(req: Request, path: string): string {
  return `${getClientIp(req)}:${bucketFor(path)}`;
}

function send429(res: Response, req: Request, limit: number, remaining: number, retryAfterSec: number): void {
  res.setHeader('Retry-After',           String(retryAfterSec));
  res.setHeader('X-RateLimit-Limit',     String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('X-RateLimit-Reset',     String(Math.ceil(Date.now() / 1000) + retryAfterSec));
  res.status(429).json({
    error: 'RATE_LIMIT_EXCEEDED',
    message: `Too many requests. Please wait ${retryAfterSec} second(s) before retrying.`,
    retryAfterSeconds: retryAfterSec,
    requestId: req.requestId,
  });
}

// ── In-memory sliding window (single-instance fallback) ─────────────────────
interface WindowEntry {
  timestamps: number[];
  blocked: number;
  lastSeen: number;
}

const WINDOW_MS      = WINDOW_SECONDS * 1000;
const MAX_STORE_SIZE = 10_000;

const store = new Map<string, WindowEntry>();

function evictOldest(): void {
  const firstKey = store.keys().next().value;
  if (firstKey !== undefined) store.delete(firstKey);
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of store.entries()) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 5 * 60_000).unref();

function checkInMemory(req: Request, res: Response, limit: number, key: string): boolean {
  const now    = Date.now();
  const cutoff = now - WINDOW_MS;

  let entry = store.get(key);
  if (!entry) {
    if (store.size >= MAX_STORE_SIZE) evictOldest();
    entry = { timestamps: [], blocked: 0, lastSeen: now };
    store.set(key, entry);
  } else {
    store.delete(key);
    store.set(key, entry);
  }

  entry.lastSeen = now;
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= limit) {
    entry.blocked++;
    const oldestInWindow = entry.timestamps[0];
    const retryAfterSec  = Math.max(1, Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000));
    send429(res, req, limit, 0, retryAfterSec);
    return false;
  }

  entry.timestamps.push(now);
  res.setHeader('X-RateLimit-Limit',     String(limit));
  res.setHeader('X-RateLimit-Remaining', String(limit - entry.timestamps.length));
  res.setHeader('X-RateLimit-Reset',     String(Math.ceil((now + WINDOW_MS) / 1000)));
  return true;
}

// ── Upstash Redis sliding window (distributed, multi-instance) ──────────────
type RedisLimiter = {
  limit: (identifier: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }>;
};

let redisLimiters: Map<number, RedisLimiter> | null | undefined;

async function getRedisLimiters(): Promise<Map<number, RedisLimiter> | null> {
  if (redisLimiters !== undefined) return redisLimiters;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    redisLimiters = null;
    return redisLimiters;
  }
  try {
    const { Redis } = await import('@upstash/redis');
    const { Ratelimit } = await import('@upstash/ratelimit');
    const redis = new Redis({ url, token });
    redisLimiters = new Map();
    for (const limit of new Set(Object.values({ chat: 20, image: 10, voice: 20, ai: 30, memory: 60, other: 60 }))) {
      redisLimiters.set(limit, new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${WINDOW_SECONDS} s`),
        prefix: 'soham:rl',
        analytics: false,
      }) as unknown as RedisLimiter);
    }
    logger.info('Rate limiter backend: Upstash Redis (distributed)');
  } catch (err) {
    logger.error('Rate limiter: failed to initialise Upstash Redis — falling back to in-memory', {
      error: err instanceof Error ? err.message : String(err),
    });
    redisLimiters = null;
  }
  return redisLimiters;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`redis timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

// ── Middleware ──────────────────────────────────────────────────────────────
export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === '/health' || req.path === '/health/' || req.path.startsWith('/health/')) {
    next();
    return;
  }

  const limit = getLimit(req.path);
  const key   = clientKey(req, req.path);

  // Distributed backend when configured
  const limiters = await getRedisLimiters();
  if (limiters) {
    const limiter = limiters.get(limit);
    if (limiter) {
      try {
        const result = await withTimeout(limiter.limit(key), REDIS_TIMEOUT_MS);
        const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
        if (!result.success) {
          send429(res, req, result.limit, result.remaining, retryAfterSec);
          return;
        }
        res.setHeader('X-RateLimit-Limit',     String(result.limit));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        res.setHeader('X-RateLimit-Reset',     String(Math.ceil(result.reset / 1000)));
        next();
        return;
      } catch (err) {
        logger.warn('Rate limiter: Redis check failed — using in-memory fallback for this request', {
          error: err instanceof Error ? err.message : String(err),
          requestId: req.requestId,
        });
        // fall through to in-memory
      }
    }
  }

  if (checkInMemory(req, res, limit, key)) next();
}
