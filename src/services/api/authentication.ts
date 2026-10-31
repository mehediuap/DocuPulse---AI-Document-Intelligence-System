import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

export type ApiTokenRegistry = ReadonlyMap<string, string>;

export function parseApiTokenRegistry(value: string | undefined): ApiTokenRegistry {
  if (!value?.trim()) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('DOCUPULSE_API_TOKENS must be a JSON object mapping bearer tokens to actor IDs.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DOCUPULSE_API_TOKENS must be a JSON object mapping bearer tokens to actor IDs.');
  }

  const registry = new Map<string, string>();
  for (const [token, actorId] of Object.entries(parsed)) {
    if (token.length < 32 || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 128) {
      throw new Error('Each API token must be at least 32 characters and map to a non-empty actor ID of at most 128 characters.');
    }
    registry.set(token, actorId.trim());
  }
  return registry;
}

export function resolveApiActor(
  authorizationHeader: string | undefined,
  registry: ApiTokenRegistry
): string | null {
  const match = authorizationHeader?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return null;

  const presented = Buffer.from(match[1]);
  for (const [token, actorId] of registry) {
    const expected = Buffer.from(token);
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
      return actorId;
    }
  }
  return null;
}

export function createApiAuthenticationMiddleware(
  registry: ApiTokenRegistry,
  isProduction: boolean
): RequestHandler {
  return (req, res, next) => {
    if (registry.size === 0) {
      if (isProduction) {
        res.status(503).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_NOT_CONFIGURED',
            message: 'API authentication is not configured.',
          },
        });
        return;
      }

      res.locals.actorId = 'local-development-user';
      next();
      return;
    }

    const actorId = resolveApiActor(req.get('authorization'), registry);
    if (!actorId) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'A valid bearer token is required.',
        },
      });
      return;
    }

    res.locals.actorId = actorId;
    next();
  };
}

export function getAuthenticatedActor(res: Response): string {
  const actorId = (res.locals as { actorId?: unknown }).actorId;
  if (typeof actorId !== 'string' || !actorId) {
    throw new Error('Authenticated API actor is missing from the request context.');
  }
  return actorId;
}

const configuredApiTokenRegistry = parseApiTokenRegistry(process.env.DOCUPULSE_API_TOKENS);
const isProduction = process.env.NODE_ENV === 'production';

export const apiAuthenticationMiddleware = createApiAuthenticationMiddleware(
  configuredApiTokenRegistry,
  isProduction
);

export function getApiAuthenticationWarning(): string {
  if (configuredApiTokenRegistry.size > 0) {
    return 'Bearer-token authentication is enabled; configure authorization policies and TLS for production.';
  }
  if (isProduction) {
    return 'API authentication is not configured; protected API routes return 503.';
  }
  return 'Development authentication bypass is enabled; this service is not suitable for public deployment.';
}
