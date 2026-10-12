import type { Algorithm } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';

// issueAccessToken() signs with a string secret and jsonwebtoken defaults,
// which is HS256. Verifiers pin it so no other algorithm is ever accepted.
export const ACCESS_TOKEN_ALGORITHMS: Algorithm[] = ['HS256'];

const BEARER_AUTHORIZATION = /^\s*bearer\s+(\S+)/i;
const WALLET_ADDRESS = /^0x[0-9a-f]{40}$/i;

export function getBearerTokenOrNull(authorization: unknown): string | null {
  if (typeof authorization !== 'string') {
    return null;
  }
  return BEARER_AUTHORIZATION.exec(authorization)?.[1] ?? null;
}

/**
 * Lowercase wallet from a Bearer access token whose signature, algorithm and
 * expiry verify against the API JWT secret. Returns null for a missing,
 * malformed, expired or otherwise unverifiable token, and for signed tokens
 * whose subject is not a wallet address. Never throws and never touches the
 * database, so it is safe to call before route-level authentication.
 */
export function getVerifiedAccessTokenWalletOrNull(
  authorization: unknown,
  resolveJwtSecret: () => string
): string | null {
  const token = getBearerTokenOrNull(authorization);
  if (!token) {
    return null;
  }
  try {
    const payload = jwt.verify(token, resolveJwtSecret(), {
      algorithms: ACCESS_TOKEN_ALGORITHMS
    });
    const subject = typeof payload === 'object' ? payload.sub : undefined;
    return typeof subject === 'string' && WALLET_ADDRESS.test(subject)
      ? subject.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
