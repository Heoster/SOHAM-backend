/**
 * Security Headers Middleware
 * Sets production-grade HTTP security headers without requiring the helmet package.
 *
 * Headers set:
 *   X-Content-Type-Options      — prevent MIME sniffing
 *   X-Frame-Options             — prevent clickjacking
 *   X-XSS-Protection            — legacy XSS filter (belt-and-suspenders)
 *   Referrer-Policy             — limit referrer leakage
 *   Permissions-Policy          — disable unused browser features
 *   Strict-Transport-Security   — force HTTPS (production only)
 *   Content-Security-Policy     — restrict resource loading for API responses
 *   Cache-Control               — prevent caching of AI responses
 */

import type { Request, Response, NextFunction } from 'express';

const isProd = process.env.NODE_ENV === 'production';

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent embedding in iframes (clickjacking)
  res.setHeader('X-Frame-Options', 'DENY');

  // Legacy XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Limit referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Disable unused browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Force HTTPS in production
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // CSP for API-only server — no HTML served, so restrictive is fine
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'"
  );

  // Prevent caching of AI responses (they are dynamic and user-specific)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  next();
}
