import { createHash, randomBytes } from 'node:crypto';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { BadRequestException } from '@/exceptions';

/**
 * Lightweight community-app identity assertion flow.
 *
 * No DB tables, no scoped JWTs, no PKCE. The flow is:
 *   1. Community app redirects to 6529.io/auth/authorize?app=...&redirect_uri=...&state=...
 *   2. 6529.io shows a branded page: "[App Name] wants to verify your 6529 identity"
 *   3. User clicks Approve (must be logged in to 6529.io)
 *   4. 6529.io stores a one-time code in Redis: { address, app } with 5-min TTL
 *   5. 6529.io redirects to redirect_uri?code=...&state=...
 *   6. Community app calls POST /auth/authorize/exchange { code } → gets { address, app }
 *   7. Community app fetches public profile via GET /api/identities/by-wallet/:address
 */

const AUTH_CODE_TTL = Time.minutes(5);
const AUTH_CODE_KEY_PREFIX = 'community_app_auth_code';

export interface CommunityApp {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedRedirectUris: readonly string[];
}

/**
 * Static app registry. To add a new community app, add it here.
 * No DB table needed — this is a curated, small list.
 */
const COMMUNITY_APPS: Readonly<Record<string, CommunityApp>> = {
  'ar-community-platform': {
    id: 'ar-community-platform',
    name: '6529 AR Platform',
    description: 'World-anchored AR layer gated by 6529.io identity',
    allowedRedirectUris: [
      'https://arweave.net/6529-ar/auth/callback',
      'http://localhost:3000/6529-ar/auth/callback',
    ],
  },
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

interface StoredAuthCode {
  readonly address: string;
  readonly app: string;
  readonly createdAt: number;
}

function authCodeKey(code: string): string {
  const codeHash = createHash('sha256').update(code).digest('hex');
  return `${AUTH_CODE_KEY_PREFIX}:${codeHash}`;
}

export async function createAuthCode(
  address: string,
  appId: string
): Promise<string> {
  const code = randomBytes(32).toString('hex');
  const payload: StoredAuthCode = {
    address: address.toLowerCase(),
    app: appId,
    createdAt: Date.now(),
  };
  await redisSetJson(authCodeKey(code), payload, AUTH_CODE_TTL);
  return code;
}

export async function exchangeAuthCode(
  code: string
): Promise<{ address: string; app: string } | null> {
  const stored = await redisGet<StoredAuthCode>(authCodeKey(code));
  if (!stored) {
    return null;
  }
  // One-time use: delete by overwriting with expired value
  // Redis TTL will clean it up, but we want immediate consumption
  // Since redisSetJson doesn't support DELETE, we re-set with 1-second TTL
  await redisSetJson(authCodeKey(code), { ...stored, address: '' }, Time.seconds(1));
  return {
    address: stored.address,
    app: stored.app,
  };
}