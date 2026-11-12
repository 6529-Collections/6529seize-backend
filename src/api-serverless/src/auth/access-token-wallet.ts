import type { Algorithm } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';
import type { AccessTokenBinding, AccessTokenClientType } from '@/auth-context';
import { readAccessTokenSessionClaims } from '@/api/auth/access-token-session';

// issueAccessToken() signs with a string secret and jsonwebtoken defaults,
// which is HS256. Verifiers pin it so no other algorithm is ever accepted.
export const ACCESS_TOKEN_ALGORITHMS: Algorithm[] = ['HS256'];

const BEARER_AUTHORIZATION = /^\s*bearer\s+(\S+)/i;
const WALLET_ADDRESS = /^0x[0-9a-f]{40}$/i;

// Claims that issueAccessToken() never sets. Other tokens signed with the
// same secret (such as login challenges) carry them, so their presence means
// the token is not an access token.
const NON_ACCESS_TOKEN_CLAIMS = ['challenge_type', 'iss', 'aud'] as const;

export interface AccessTokenClaims {
  readonly wallet: string;
  readonly role: string | undefined;
  readonly exp: number;
  // Session claims; present only when the token carries them.
  readonly clientType?: AccessTokenClientType;
  readonly binding?: AccessTokenBinding;
  readonly sessionId?: string;
}

export function getBearerTokenOrNull(authorization: unknown): string | null {
  if (typeof authorization !== 'string') {
    return null;
  }
  return BEARER_AUTHORIZATION.exec(authorization)?.[1] ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Claims of a verified access token, or null when the verified payload does
 * not have the shape issueAccessToken() produces: a JSON object whose subject
 * is a wallet address, with a numeric expiry, an optional string role and no
 * claims that only other token types carry. The wallet is lowercase.
 * Session claims (`ct`, `sb`, `sid`) are optional: a token without them, or
 * with a value this build does not know, is still an access token.
 */
export function getAccessTokenClaimsOrNull(
  payload: unknown
): AccessTokenClaims | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  const { sub, role, exp } = payload;
  if (typeof sub !== 'string' || !WALLET_ADDRESS.test(sub)) {
    return null;
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return null;
  }
  if (!isOptionalString(role)) {
    return null;
  }
  if (NON_ACCESS_TOKEN_CLAIMS.some((claim) => payload[claim] !== undefined)) {
    return null;
  }
  const session = readAccessTokenSessionClaims(payload);
  return {
    wallet: sub.toLowerCase(),
    role,
    exp,
    ...(session.clientType ? { clientType: session.clientType } : {}),
    ...(session.binding ? { binding: session.binding } : {}),
    ...(session.sessionId ? { sessionId: session.sessionId } : {})
  };
}

/**
 * Lowercase wallet from a Bearer access token whose signature, algorithm and
 * expiry verify against the API JWT secret. Returns null for a missing,
 * malformed, expired or otherwise unverifiable token, and for signed tokens
 * that are not access tokens. Never throws and never touches the database, so
 * it is safe to call before route-level authentication.
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
    return getAccessTokenClaimsOrNull(payload)?.wallet ?? null;
  } catch {
    return null;
  }
}
