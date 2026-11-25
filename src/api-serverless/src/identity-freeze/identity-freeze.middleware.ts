import { NextFunction, Request, Response } from 'express';
import {
  IdentityFrozenException,
  isIdentityFrozen
} from '@/identity-freeze/identity-freeze';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routers whose every write changes a profile, a handle, a profile statement,
 * a REP or NIC rating, or a profile picture or profile wave:
 * /profiles (and /profiles/:identity/cic, /rep, /pfp, /wave), /ratings and
 * /bulk-rep. Paths are relative to the API router (after /api).
 */
const FROZEN_ROUTERS: RegExp[] = [
  /^\/profiles(?:\/|$)/i,
  /^\/ratings(?:\/|$)/i,
  /^\/bulk-rep(?:\/|$)/i
];

/** POST /proxies/:proxy_id/actions: frozen only for REP and NIC allocations. */
const PROXY_ACTIONS = /^\/proxies\/[^/]+\/actions\/?$/i;

export const FROZEN_PROXY_ACTION_TYPES: ReadonlySet<string> = new Set([
  'ALLOCATE_REP',
  'ALLOCATE_CIC'
]);

export interface IdentityWriteCandidate {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

function proxyActionType(body: unknown): string | null {
  if (body && typeof body === 'object' && 'action_type' in body) {
    const type = (body as { action_type?: unknown }).action_type;
    return typeof type === 'string' ? type.toUpperCase() : null;
  }
  return null;
}

/**
 * Whether a request would change identity data that the freeze covers.
 * Reads never do. Wave, drop and wave-proxy writes never do.
 */
export function isFrozenIdentityWrite({
  method,
  path,
  body
}: IdentityWriteCandidate): boolean {
  if (READ_METHODS.has(method.toUpperCase())) {
    return false;
  }
  if (FROZEN_ROUTERS.some((router) => router.test(path))) {
    return true;
  }
  if (PROXY_ACTIONS.test(path)) {
    const type = proxyActionType(body);
    return type !== null && FROZEN_PROXY_ACTION_TYPES.has(type);
  }
  return false;
}

/**
 * Refuses identity writes with 423 and code IDENTITY_FROZEN while
 * FEATURE_IDENTITY_FROZEN is on. Mount it on the API router before the
 * routers it covers. The services guard the writes no route shows (see
 * src/identity-freeze).
 */
export function identityFreezeMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (
      isIdentityFrozen() &&
      isFrozenIdentityWrite({
        method: req.method,
        path: req.path,
        body: req.body
      })
    ) {
      next(new IdentityFrozenException());
      return;
    }
    next();
  };
}
