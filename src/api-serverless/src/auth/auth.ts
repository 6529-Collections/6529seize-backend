import * as passport from 'passport';
import { Request } from 'express';
import { profilesService } from '../../../profiles/profiles.service';
import { profileProxyApiService } from '../proxies/proxy.api.service';
import {
  AuthenticatedProxyAction,
  AuthenticationContext
} from '../../../auth-context';
import { areEqualAddresses, resolveEnum } from '../../../helpers';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { Time } from '../../../time';
import { ProfileProxyAction } from '../generated/models/ProfileProxyAction';
import { SUBSCRIPTIONS_ADMIN_WALLETS } from '../../../constants';

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
  return profilesService
    .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(authWallet)
    .then((profile) => profile?.profile?.external_id ?? null);
}

export async function getAuthenticationContext(
  req: Request<any, any, any, any, any>
): Promise<AuthenticationContext> {
  const authenticatedWallet = getWalletOrThrow(req);
  const roleProfileId = (req.user as any).role as string | null;
  const authenticatedProfileId = await profilesService
    .getProfileByWallet(authenticatedWallet)
    .then((profile) => profile?.profile?.external_id ?? null);
  const activeProxyActions =
    authenticatedProfileId &&
    roleProfileId &&
    authenticatedProfileId !== roleProfileId
      ? await profileProxyApiService
          .getProxyByGrantedByAndGrantedTo({
            granted_by_profile_id: roleProfileId,
            granted_to_profile_id: authenticatedProfileId
          })
          ?.then((proxy) =>
            (proxy?.actions ?? [])
              .filter(isProxyActionActive)
              .map<AuthenticatedProxyAction>((action) => ({
                id: action.id,
                type: resolveEnum(
                  ApiProfileProxyActionType,
                  action.action_type
                )!,
                credit_spent: action.credit_spent,
                credit_amount: action.credit_amount
              }))
          )
      : [];
  return new AuthenticationContext({
    authenticatedWallet,
    authenticatedProfileId,
    roleProfileId,
    activeProxyActions
  });
}

function isProxyActionActive(action: ProfileProxyAction): boolean {
  const now = Time.now();
  return (
    !action.end_time ||
    (Time.millis(action.end_time).gte(now) &&
      (!action.start_time || Time.millis(action.start_time).lte(now)) &&
      (!action.rejected_at || Time.millis(action.rejected_at).gte(now)) &&
      (!action.revoked_at || Time.millis(action.revoked_at).gte(now)))
  );
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
