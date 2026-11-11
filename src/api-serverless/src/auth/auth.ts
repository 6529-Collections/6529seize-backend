import * as passport from 'passport';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  isProxyActionActive,
  profileProxyApiService
} from '../proxies/proxy.api.service';
import {
  AccessTokenSession,
  AuthenticatedProxyAction,
  AuthenticationContext
} from '../../../auth-context';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { Time, Timer } from '../../../time';
import * as mcache from 'memory-cache';
import { identitiesDb } from '../../../identities/identities.db';
import { identityFetcher } from '../identities/identity.fetcher';
import { enums } from '../../../enums';
import { loggerContext } from '../../../logger-context';
import { UnauthorisedException } from '@/exceptions';
import {
  hasAccessTokenSessionClaims,
  readAccessTokenSessionClaims
} from '@/api/auth/access-token-session';

export function getJwtSecret(): string {
  const jwtsecret = process.env.JWT_SECRET;
  if (!jwtsecret) {
    throw new Error('JWT_SECRET env var not found');
  }
  return jwtsecret;
}

export function getJwtExpiry(): number {
  const jwtExpiry = process.env.JWT_EXPIRY_SECONDS;
  if (!jwtExpiry || typeof jwtExpiry !== 'string') {
    throw new Error('JWT_EXPIRY_SECONDS env var not found');
  }
  const jwtExpiryNumber = parseInt(jwtExpiry);
  if (isNaN(jwtExpiryNumber) || jwtExpiryNumber <= 0) {
    throw new Error('JWT_EXPIRY_SECONDS env var must be a positive integer');
  }
  return jwtExpiryNumber;
}

function updateJwtContext(user: any) {
  if (!user) {
    loggerContext.setJwtSub(undefined);
    return;
  }
  if (typeof user.wallet === 'string') {
    loggerContext.setJwtSub(user.wallet.toLowerCase());
    return;
  }
  if (typeof user.sub === 'string') {
    loggerContext.setJwtSub(user.sub);
    return;
  }
  loggerContext.setJwtSub(undefined);
}

type AnyRequestHandler = RequestHandler<any, any, any, any>;

function runAuthenticate(
  authenticate: AnyRequestHandler,
  req: Request,
  res: Response,
  next: NextFunction
) {
  authenticate(req, res, (err?: any) => {
    if (err) {
      next(err);
      return;
    }
    updateJwtContext(req.user);
    next();
  });
}

export function needsAuthenticatedUser(): AnyRequestHandler {
  const authenticate = passport.authenticate('jwt', {
    session: false
  }) as unknown as AnyRequestHandler;
  const handler: AnyRequestHandler = (req, res, next) => {
    runAuthenticate(authenticate, req, res, next);
  };
  return handler;
}

export function maybeAuthenticatedUser(): AnyRequestHandler {
  const authenticate = passport.authenticate(['jwt', 'anonymous'], {
    session: false
  }) as unknown as AnyRequestHandler;
  const handler: AnyRequestHandler = (req, res, next) => {
    runAuthenticate(authenticate, req, res, next);
  };
  return handler;
}

export function getAuthenticatedWalletOrNull(
  req: Request<any, any, any, any, any>
): string | null {
  const user = req.user as { wallet?: unknown } | undefined;
  if (!user) {
    return null;
  }
  if (typeof user.wallet !== 'string' || !user.wallet) {
    throw new UnauthorisedException('Invalid access token');
  }
  return user.wallet.toLowerCase();
}

/**
 * Session claims of the caller's access token, or null when the request is
 * anonymous or the token predates them.
 */
export function getAccessTokenSessionOrNull(
  req: Request<any, any, any, any, any>
): AccessTokenSession | null {
  const user = req.user as Record<string, unknown> | undefined;
  if (!user) {
    return null;
  }
  const session = readAccessTokenSessionClaims({
    ct: user.clientType,
    sb: user.binding,
    sid: user.sessionId
  });
  return hasAccessTokenSessionClaims(session) ? session : null;
}

export async function getAuthenticatedProfileIdOrNull(
  req: Request<any, any, any, any, any>
): Promise<string | null> {
  const authWallet = getAuthenticatedWalletOrNull(req);
  if (!authWallet) {
    return null;
  }
  return identityFetcher.getProfileIdByIdentityKey(
    { identityKey: authWallet },
    {}
  );
}

export async function getAuthenticationContext(
  req: Request<any, any, any, any, any>,
  timer?: Timer
): Promise<AuthenticationContext> {
  const authenticatedWallet = getAuthenticatedWalletOrNull(req);
  if (!authenticatedWallet) {
    return AuthenticationContext.notAuthenticated();
  }
  const roleProfileId = (req.user as any).role as string | null;
  const accessTokenSession = getAccessTokenSessionOrNull(req);
  const cacheKey = `auth-context-${authenticatedWallet}-${roleProfileId}-${accessTokenSessionCacheKey(accessTokenSession)}`;
  const cachedContext = mcache.get(cacheKey);
  if (cachedContext) {
    return cachedContext;
  }
  timer?.start('getAuthenticationContext');
  const authenticatedProfileId = await identitiesDb.getProfileIdByWallet(
    authenticatedWallet,
    timer
  );
  let activeProxyActions: AuthenticatedProxyAction[] = [];
  const isAuthenticatedAsProxy =
    authenticatedProfileId &&
    roleProfileId &&
    authenticatedProfileId !== roleProfileId;
  if (isAuthenticatedAsProxy) {
    activeProxyActions = await profileProxyApiService
      .getProxyByGrantedByAndGrantedTo({
        granted_by_profile_id: roleProfileId,
        granted_to_profile_id: authenticatedProfileId
      })
      ?.then((proxy) =>
        (proxy?.actions ?? [])
          .filter(isProxyActionActive)
          .map<AuthenticatedProxyAction>((action) => ({
            id: action.id,
            type: enums.resolve(ProfileProxyActionType, action.action_type)!,
            credit_spent: action.credit_spent,
            credit_amount: action.credit_amount
          }))
      );
  }
  timer?.stop('getAuthenticationContext');
  const authenticationContext = new AuthenticationContext({
    authenticatedWallet,
    authenticatedProfileId,
    roleProfileId,
    activeProxyActions,
    accessTokenSession
  });
  // A wallet without a profile is usually about to create one. Caching that
  // answer would keep the new profile invisible on this instance for a minute.
  if (authenticatedProfileId) {
    mcache.put(cacheKey, authenticationContext, Time.minutes(1).toMillis());
  }
  return authenticationContext;
}

function accessTokenSessionCacheKey(
  session: AccessTokenSession | null
): string {
  return session
    ? `${session.clientType}-${session.binding}-${session.sessionId}`
    : 'none';
}

export function getWalletOrThrow(
  req: Request<any, any, any, any, any>
): string {
  const wallet = getAuthenticatedWalletOrNull(req);
  if (!wallet) {
    throw new Error('Wallet not found');
  }
  return wallet;
}
