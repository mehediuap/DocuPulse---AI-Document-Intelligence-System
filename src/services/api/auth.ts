/**
 * API-key authentication and in-memory rate limiting for the REST API.
 *
 * - DOCUPULSE_API_KEY unset + NODE_ENV=production  -> every protected request is refused (fail closed).
 * - DOCUPULSE_API_KEY unset + development          -> requests are allowed and a warning is logged once.
 * - /health stays public so load balancers can probe it.
 *
 * NOTE: a key baked into a browser bundle (VITE_API_KEY) is NOT a secret. For a real deployment put the
 * app behind SSO / an auth proxy and issue per-user sessions; this middleware protects the API from
 * anonymous callers and scripts, nothing more.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function reject(res: Response, status: number, code: string, message: string, headers: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json({ success: false, error: { code, message } });
}

export function createApiKeyAuth(env: NodeJS.ProcessEnv = process.env) {
  let warned = false;
  return function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/health') return next();
    const expected = env.DOCUPULSE_API_KEY?.trim();
    if (!expected) {
      if (env.NODE_ENV === 'production' && !env.DOCUPULSE_API_TOKENS?.trim()) {
        return reject(res, 503, 'AUTH_NOT_CONFIGURED', 'Server authentication is not configured.');
      }
      if (!env.DOCUPULSE_API_TOKENS?.trim() && !warned) {
        warned = true;
        console.warn('[DocuPulse] DOCUPULSE_API_KEY is not set: API is UNAUTHENTICATED (development only).');
      }
      return next();
    }
    const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const provided = req.header('x-api-key') || bearer || '';
    if (!provided || !safeEqual(provided, expected)) {
      return reject(res, 401, 'UNAUTHORIZED', 'A valid API key is required.', { 'WWW-Authenticate': 'Bearer' });
    }
    next();
  };
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  now?: () => number;
}

/** Fixed-window limiter keyed by client IP. Per-process only; use a shared limiter behind multiple nodes. */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 120;
  const now = options.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const t = now();
    if (hits.size > 10_000) {
      for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
      if (hits.size > 10_000) hits.clear();            // hard bound on memory
    }
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      return reject(res, 429, 'RATE_LIMITED', 'Too many requests. Please retry later.',
        { 'Retry-After': String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))) });
    }
    next();
  };
}
