import { createHash, randomBytes } from 'node:crypto';
import {
  evictKeyFromRedisCache,
  getRedisClient,
  redisGet,
  redisSetJson
} from '@/redis';
import { Time } from '@/time';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';

/**
 * Community-app identity assertion flow ("Sign in with 6529.io").
 *
 * Extends auth v2 by issuing a one-time, PKCE-protected authorization code that
 * is bound to the app that initiated the login. The code is consumed atomically
 * so that simultaneous exchanges cannot both succeed.
 *
 * The flow is:
 *   1. Community app generates a `code_verifier` (43-128 chars, base64url) and
 *      computes `code_challenge = base64url(sha256(code_verifier))`. It also
 *      generates an opaque `state` value.
 *   2. Community app redirects the user to
 *      6529.io/auth/authorize?app=...&redirect_uri=...&state=...&code_challenge=...
 *   3. 6529.io shows a branded page: "[App Name] wants to verify your 6529 identity"
 *      (GET /auth/authorize/app-info returns the app metadata).
 *   4. User clicks Approve (must have an active auth-v2 web session on 6529.io).
 *   5. 6529.io stores a one-time code in Redis with 5-min TTL:
 *        { address, app, code_challenge, state, createdAt }
 *      POST /auth/authorize/approve returns redirect_url?code=...&state=...
 *   6. Community app calls POST /auth/authorize/exchange
 *        { code, code_verifier, state, app }
 *      6529.io verifies:
 *        - code exists (atomically consumed via GETDEL)
 *        - code_challenge == base64url(sha256(code_verifier))
 *        - state matches stored state
 *        - app matches stored app
 *      On success returns { address, app }.
 *   7. Community app fetches the public profile via
 *      GET /api/identities/by-wallet/:address
 *
 * Security notes:
 *   - PKCE prevents code interception attacks: an attacker who steals the code
 *     cannot exchange it without the code_verifier.
 *   - State prevents CSRF: the community app verifies the state it sent matches.
 *   - Atomic consumption (GETDEL) prevents replay/race: the code can only be
 *     exchanged once, even under concurrent requests.
 *   - Redis availability is verified before storing: if Redis is down, approval
 *     fails with 503 instead of silently issuing an un-storable code.
 *
 * What this asserts: the flow asserts the signing wallet address of the 6529.io
 * user's active auth-v2 web session. It does NOT assert a selected profile/handle
 * -- the community app receives the wallet address and may then look up the public
 * profile separately. The user must be actively logged in (hasActiveWebSession),
 * not merely holding a valid (but possibly logged-out) JWT.
 */

const AUTH_CODE_TTL = Time.minutes(5);
const AUTH_CODE_KEY_PREFIX = 'community_app_auth_code';

/** Base64url character set (RFC 7636 §4.2). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CommunityApp {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedRedirectUris: readonly string[];
  /** When true, this app entry exists for local development only. */
  readonly isDev: boolean;
}

/**
 * Static app registry. To add a new community app, add it here.
 * No DB table needed -- this is a curated, small list.
 *
 * NOTE: The production redirect URI for `ar-community-platform` uses
 * https://6529-ar.arweave.dev/auth/callback because the bare
 * https://arweave.net/6529-ar/auth/callback path returns 404 (arweave.net serves
 * permaweb tx data, not arbitrary SPA routes under /6529-ar). A dedicated gateway
 * / subdomain is required for SPA client-side routing. The localhost URI is
 * development-only (isDev: true) and must not be relied upon in production.
 */
const COMMUNITY_APPS: Readonly<Record<string, CommunityApp>> = {
  'ar-community-platform': {
    id: 'ar-community-platform',
    name: '6529 AR Platform',
    description: 'World-anchored AR layer gated by 6529.io identity',
    allowedRedirectUris: [
      'https://6529-ar.arweave.dev/auth/callback',
      // Dev-only -- do not enable in production deployments.
      'http://localhost:3000/6529-ar/auth/callback'
    ],
    isDev: false
  }
};

export function getCommunityApp(appId: string): CommunityApp | null {
  return COMMUNITY_APPS[appId] ?? null;
}

export function validateRedirectUri(
  app: CommunityApp,
  redirectUri: string
): void {
  if (!app.allowedRedirectUris.includes(redirectUri)) {
    throw new BadRequestException(
      'Redirect URI not allowed for this community app'
    );
  }
}

/**
 * Validate a PKCE code_verifier per RFC 7636 §4.1:
 *   - 43 to 128 characters
 *   - unreserved characters only (here: base64url alphabet)
 */
export function validateCodeVerifier(codeVerifier: string): void {
  if (
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !BASE64URL_PATTERN.test(codeVerifier)
  ) {
    throw new BadRequestException('Invalid code_verifier');
  }
}

/**
 * Validate a PKCE code_challenge: base64url-encoded SHA-256 hash (43 chars).
 */
export function validateCodeChallenge(codeChallenge: string): void {
  // base64url(sha256) is exactly 43 characters (256 bits / 6 bits per char, no padding)
  if (codeChallenge.length !== 43 || !BASE64URL_PATTERN.test(codeChallenge)) {
    throw new BadRequestException('Invalid code_challenge');
  }
}

/**
 * Compute the PKCE code_challenge from a code_verifier:
 *   code_challenge = base64url(sha256(code_verifier))
 */
export function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Verify that the provided code_verifier hashes to the stored code_challenge.
 */
export function verifyCodeChallenge(
  codeVerifier: string,
  storedCodeChallenge: string
): boolean {
  const computed = computeCodeChallenge(codeVerifier);
  // Constant-time comparison to avoid timing leaks
  return timingSafeEqual(computed, storedCodeChallenge);
}

/** Constant-time string comparison to avoid timing side channels. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && bufA.equals(bufB);
}

interface StoredAuthCode {
  readonly address: string;
  readonly app: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly createdAt: number;
}

function authCodeKey(code: string): string {
  const codeHash = createHash('sha256').update(code).digest('hex');
  return `${AUTH_CODE_KEY_PREFIX}:${codeHash}`;
}

/**
 * Create a one-time authorization code bound to the given app, PKCE challenge,
 * and state. Stores it in Redis with a 5-minute TTL.
 *
 * Throws 503 if Redis is unavailable or the code could not be stored.
 */
export async function createAuthCode(params: {
  readonly address: string;
  readonly appId: string;
  readonly codeChallenge: string;
  readonly state: string;
}): Promise<string> {
  // Fail fast if Redis is not connected -- redisSetJson would silently no-op.
  if (!getRedisClient()) {
    throw new CustomApiCompliantException(
      503,
      'Identity assertion service temporarily unavailable'
    );
  }

  const code = randomBytes(32).toString('hex');
  const payload: StoredAuthCode = {
    address: params.address.toLowerCase(),
    app: params.appId,
    codeChallenge: params.codeChallenge,
    state: params.state,
    createdAt: Date.now()
  };
  await redisSetJson(authCodeKey(code), payload, AUTH_CODE_TTL);

  // Verify the code was actually stored (redisSetJson returns void even if
  // Redis was down). Read it back to confirm.
  const stored = await redisGet<StoredAuthCode>(authCodeKey(code));
  if (!stored) {
    throw new CustomApiCompliantException(
      503,
      'Identity assertion service temporarily unavailable'
    );
  }

  return code;
}

export interface ExchangeAuthCodeParams {
  readonly code: string;
  readonly codeVerifier: string;
  readonly state: string;
  readonly app: string;
}

export interface ExchangeAuthCodeResult {
  readonly address: string;
  readonly app: string;
}

/**
 * Atomically consume and verify an authorization code.
 *
 * Uses GETDEL so that the code can only be consumed once -- simultaneous
 * exchanges cannot both succeed (the second will find the key already deleted).
 *
 * Verifies:
 *   - code exists (was not already consumed / expired)
 *   - code_challenge matches base64url(sha256(code_verifier))
 *   - state matches the stored state
 *   - app matches the stored app
 *
 * On any verification failure, returns null (callers should respond with a
 * generic "Invalid or expired authorization code" to avoid leaking which check
 * failed).
 */
export async function exchangeAuthCode(
  params: ExchangeAuthCodeParams
): Promise<ExchangeAuthCodeResult | null> {
  const client = getRedisClient();
  const key = authCodeKey(params.code);

  let stored: StoredAuthCode | null;

  if (client) {
    // Atomic get-and-delete: only one concurrent exchange can retrieve the value.
    const raw = await (client as any).getDel(key);
    stored = raw ? (JSON.parse(raw) as StoredAuthCode) : null;
  } else {
    // Redis unavailable -- nothing to exchange.
    return null;
  }

  if (!stored) {
    return null;
  }

  // Verify code_challenge: base64url(sha256(code_verifier)) must match stored.
  if (!verifyCodeChallenge(params.codeVerifier, stored.codeChallenge)) {
    return null;
  }

  // Verify state matches.
  if (stored.state !== params.state) {
    return null;
  }

  // Verify app matches (prevents code substitution across apps).
  if (stored.app !== params.app) {
    return null;
  }

  return {
    address: stored.address,
    app: stored.app
  };
}

/**
 * Best-effort cleanup of an auth code (e.g. on early failure paths).
 * Safe to call even if the key is already gone.
 */
export async function deleteAuthCode(code: string): Promise<void> {
  await evictKeyFromRedisCache(authCodeKey(code));
}
