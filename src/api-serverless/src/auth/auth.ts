import * as passport from 'passport';
import { Request } from 'express';
import {
  isProxyActionActive,
  profileProxyApiService
} from '../proxies/proxy.api.service';
import {
  AuthenticatedProxyAction,
  AuthenticationContext
} from '../../../auth-context';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { Time, Timer } from '../../../time';
import * as mcache from 'memory-cache';
import { identitiesDb } from '../../../identities/identities.db';
import { identityFetcher } from '../identities/identity.fetcher';
import { enums } from '../../../enums';

export function getJwtSecret() {
  const jwtsecret = process.env.JWT_SECRET;
  if (!jwtsecret) {
    throw new Error('JWT_SECRET env var not found');
  }
  return jwtsecret;
}

export function getJwtExpiry(): string {
  const jwtExpiry = process.env.JWT_EXPIRY_SECONDS;
  if (!jwtExpiry || typeof jwtExpiry !== 'string') {
    throw new Error('JWT_EXPIRY_SECONDS env var not found');
  }
  const jwtExpiryNumber = parseInt(jwtExpiry);
  if (isNaN(jwtExpiryNumber) || jwtExpiryNumber <= 0) {
    throw new Error('JWT_EXPIRY_SECONDS env var must be a positive integer');
  }
  return `${jwtExpiryNumber}s`;
}

export function needsAuthenticatedUser() {
  return passport.authenticate('jwt', { session: false });
}

export function maybeAuthenticatedUser() {
  return passport.authenticate(['jwt', 'anonymous'], { session: false });
}

export function getAuthenticatedWalletOrNull(
  req: Request<any, any, any, any, any>
): string | null {
  const user = req.user as any;
  if (!user) {
    return null;
  }
  return user.wallet.toLowerCase();
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
  const cacheKey = `auth-context-${authenticatedWallet}-${roleProfileId}`;
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
    activeProxyActions
  });
  mcache.put(cacheKey, authenticationContext, Time.minutes(1).toMillis());
  return authenticationContext;
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
