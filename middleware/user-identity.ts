import type { Request, Response, NextFunction } from 'express';
import { createPublicKey, verify } from 'crypto';

declare global {
  namespace Express { interface Request { verifiedUserId?: string } }
}

let firebaseKeys: { project: string; expires: number; keys: any[] } | undefined;

/** Verify identity against a configured authority, never a caller-supplied userId. */
export async function verifyUserToken(token: string): Promise<string> {
  const provider = process.env.USER_AUTH_PROVIDER || (process.env.FIREBASE_PROJECT_ID ? 'firebase' : 'supabase');
  if (provider === 'firebase') {
    const project = process.env.FIREBASE_PROJECT_ID;
    if (!project) throw new Error('Identity provider not configured');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid algorithm');
    if (!firebaseKeys || firebaseKeys.project !== project || firebaseKeys.expires < Date.now()) {
      const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error('Identity service unavailable');
      const data: any = await res.json();
      if (!Array.isArray(data.keys)) throw new Error('Invalid key response');
      firebaseKeys = { project, keys: data.keys, expires: Date.now() + 300_000 };
    }
    const jwk = firebaseKeys.keys.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid signature');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Date.now() / 1000;
    if (claims.iss !== `https://securetoken.google.com/${project}` || claims.aud !== project ||
      typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + 60 ||
      typeof claims.auth_time !== 'number' || claims.auth_time > now + 60 ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new Error('Invalid claims');
    return claims.sub;
  }
  if (provider !== 'supabase') throw new Error('Unsupported identity provider');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Identity provider not configured');
  const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error('Invalid identity');
  const user: any = await res.json();
  if (typeof user.id !== 'string' || !user.id || user.role === 'service_role') throw new Error('Invalid user');
  return user.id;
}

export function userIdentityMiddleware(verifier = verifyUserToken) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.path === '/health' || req.path.startsWith('/health/')) { next(); return; }
    // Public knowledge from conversations is quarantined, including direct APIs.
    if (/^\/memory\/knowledge(?:\/|$)/.test(req.path)) {
      res.status(403).json({ error: 'SHARED_KNOWLEDGE_QUARANTINED' }); return;
    }
    const token = req.headers['x-user-token'];
    const claimed = [req.body?.userId, req.query?.userId].filter(value => value !== undefined);
    const privateRoute = /^\/(?:memory|documents)(?:\/|$)/.test(req.path);
    if (!token) {
      if (claimed.length || privateRoute) { res.status(401).json({ error: 'USER_AUTH_REQUIRED', message: 'Send a signed user ID/access token in X-User-Token. A shared API key is not a user identity.' }); return; }
      next(); return; // Stateless chat is allowed; no userId means no private memory.
    }
    if (typeof token !== 'string' || token.length > 16_384) { res.status(401).json({ error: 'INVALID_USER_TOKEN' }); return; }
    try {
      const uid = await verifier(token.replace(/^Bearer /i, ''));
      if (!uid || claimed.some(value => typeof value !== 'string' || value !== uid)) {
        res.status(403).json({ error: 'USER_ID_MISMATCH' }); return;
      }
      req.verifiedUserId = uid;
      next();
    } catch { res.status(401).json({ error: 'INVALID_USER_TOKEN', message: 'User identity could not be verified. No private data was accessed.' }); }
  };
}

/** Repeat ownership checks after route params/multipart fields are parsed. */
export function requireOwnedUser(req: Request, res: Response): string | undefined {
  const uid = req.verifiedUserId;
  if (!uid) { res.status(401).json({ error: 'USER_AUTH_REQUIRED' }); return; }
  const claims = [req.params?.userId, req.body?.userId, req.query?.userId].filter(value => value !== undefined);
  if (claims.some(value => typeof value !== 'string' || value !== uid)) { res.status(403).json({ error: 'USER_ID_MISMATCH' }); return; }
  return uid;
}
