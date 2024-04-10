import * as passport from 'passport';
import { Request } from 'express';
import { profilesService } from '../../../profiles/profiles.service';

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

export function getAuthenticatedWalletOrNull(req: Request): string | null {
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

export function getWalletOrThrow(
  req: Request<any, any, any, any, any>
): string {
  const wallet = getAuthenticatedWalletOrNull(req);
  if (!wallet) {
    throw new Error('Wallet not found');
  }
  return wallet;
}
