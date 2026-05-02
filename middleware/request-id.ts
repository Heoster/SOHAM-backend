/**
 * Request ID Middleware
 * Attaches a unique correlation ID to every request for distributed tracing.
 * The ID is returned in the X-Request-ID response header.
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Honour an incoming X-Request-ID (from a proxy / frontend) or generate one
  const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();
  req.requestId = id;
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', id);
  next();
}
