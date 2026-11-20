/**
 * Bearer token verification — constant-time.
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses SHA-256 of both sides before timingSafeEqual so the comparison does not
 * leak the expected key's length, and runs in constant time on the digest.
 * Centralised here so middleware and health handlers use the same rule.
 */

import { createHash, timingSafeEqual } from 'crypto';

export function isValidBearer(header: string | undefined | null): boolean {
  const expected = process.env.SOHAM_API_KEY;
  if (!expected || !header) return false;

  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (presented === null || presented.length === 0) return false;

  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
