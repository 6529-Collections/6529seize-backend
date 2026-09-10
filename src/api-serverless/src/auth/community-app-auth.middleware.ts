import { NextFunction, Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { getJwtSecret } from './auth';

export interface CommunityAppAuthPayload {
  readonly sub: string;
  readonly aud: string;
  readonly scope: string;
  readonly role?: string | null;
  readonly type: string;
}

export function verifyCommunityAppToken(
  token: string,
  expectedClientId: string
): CommunityAppAuthPayload {
  const decoded = jwt.verify(token, getJwtSecret()) as any;
  if (decoded.type !== 'community_app') {
    throw new Error('Token is not a community app token');
  }
  if (decoded.aud !== expectedClientId) {
    throw new Error('Token audience mismatch');
  }
  return {
    sub: decoded.sub,
    aud: decoded.aud,
    scope: decoded.scope,
    role: decoded.role ?? null,
    type: decoded.type
  };
}

export function needsCommunityAppAuth(expectedClientId: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }
    const token = authHeader.substring(7);
    try {
      const payload = verifyCommunityAppToken(token, expectedClientId);
      (req as any).communityAppAuth = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

export function hasScope(
  req: Request,
  requiredScope: string
): boolean {
  const auth = (req as any).communityAppAuth as
    | CommunityAppAuthPayload
    | undefined;
  if (!auth) return false;
  return auth.scope.split(' ').includes(requiredScope);
}