import * as passport from 'passport';
import { Request } from 'express';
import { CONNECTED_WALLET_HEADER } from '../api-constants';

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

export function getWalletOrThrow(req: Request): string {
  const wallet = getAuthenticatedWalletOrNull(req);
  if (!wallet) {
    throw new Error('Wallet not found');
  }
  return wallet;
}

export function getConnectedWalletOrNull(req: Request): string | null {
  const header = req.headers[CONNECTED_WALLET_HEADER];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }
  return header ?? null;
}
