import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { env } from '../../../env';
import { Logger } from '../../../logging';
import { getRedisClient } from '../../../redis';

const logger = Logger.get('RATE_LIMIT_UTILS');

export interface RateLimitConfig {
  burst: number;
  sustainedRps: number;
  sustainedWindowSeconds: number;
}

function bucketConfig(
  prefix: string,
  defaults: RateLimitConfig
): RateLimitConfig {
  return {
    burst: env.getIntOrNull(`${prefix}_BURST`) ?? defaults.burst,
    sustainedRps:
      env.getIntOrNull(`${prefix}_SUSTAINED_RPS`) ?? defaults.sustainedRps,
    sustainedWindowSeconds:
      env.getIntOrNull(`${prefix}_SUSTAINED_WINDOW_SECONDS`) ??
      defaults.sustainedWindowSeconds
  };
}

export function getRateLimitConfig(): {
  enabled: boolean;
  authenticated: RateLimitConfig;
  unauthenticated: RateLimitConfig;
  /**
   * Per source address ceiling for requests that carry a valid access
   * token, on top of the per-wallet budget: wallets are free to create, so
   * one address cannot multiply its budget by rotating them.
   */
  authenticatedAddress: RateLimitConfig;
  /** Per source address budget for the sign-in nonce and login endpoints. */
  signIn: RateLimitConfig;
  sessionRefresh: RateLimitConfig;
  internal: {
    enabled: boolean;
    clientId: string | null;
    secret: string | null;
  };
} {
  const rateLimitEnabled =
    env.getStringOrNull('API_RATE_LIMIT_ENABLED') === 'true';

  const redis = getRedisClient();
  if (rateLimitEnabled && !redis) {
    logger.warn(
      'API_RATE_LIMIT_ENABLED SET TO TRUE BUT REDIS NOT AVAILABLE - Rate Limiting will be disabled'
    );
  }

  const enabled = rateLimitEnabled && !!redis;

  const internalId = env.getStringOrNull('API_RATE_LIMIT_INTERNAL_ID');
  const internalSecret = env.getStringOrNull('API_RATE_LIMIT_INTERNAL_SECRET');
  const internalEnabled = !!(internalId && internalSecret);

  return {
    enabled,
    authenticated: {
      burst: env.getIntOrNull('API_RATE_LIMIT_AUTH_BURST') ?? 45,
      sustainedRps: env.getIntOrNull('API_RATE_LIMIT_AUTH_SUSTAINED_RPS') ?? 15,
      sustainedWindowSeconds:
        env.getIntOrNull('API_RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS') ?? 60
    },
    unauthenticated: {
      burst: env.getIntOrNull('API_RATE_LIMIT_UNAUTH_BURST') ?? 30,
      sustainedRps:
        env.getIntOrNull('API_RATE_LIMIT_UNAUTH_SUSTAINED_RPS') ?? 10,
      sustainedWindowSeconds:
        env.getIntOrNull('API_RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS') ?? 60
    },
    // Four fully used wallet budgets, so several signed-in people behind one
    // NAT stay well inside it.
    authenticatedAddress: bucketConfig('API_RATE_LIMIT_AUTH_IP', {
      burst: 240,
      sustainedRps: 60,
      sustainedWindowSeconds: 60
    }),
    // A sign-in is one nonce and one login request; 60 per minute per
    // address leaves room for retries, several wallets and shared networks.
    signIn: bucketConfig('API_RATE_LIMIT_SIGN_IN', {
      burst: 10,
      sustainedRps: 1,
      sustainedWindowSeconds: 60
    }),
    sessionRefresh: {
      burst: env.getIntOrNull('API_RATE_LIMIT_REFRESH_BURST') ?? 90,
      sustainedRps:
        env.getIntOrNull('API_RATE_LIMIT_REFRESH_SUSTAINED_RPS') ?? 30,
      sustainedWindowSeconds:
        env.getIntOrNull('API_RATE_LIMIT_REFRESH_SUSTAINED_WINDOW_SECONDS') ??
        10
    },
    internal: {
      enabled: internalEnabled,
      clientId: internalId,
      secret: internalSecret
    }
  };
}

export function generateBurstKey(
  identifier: string,
  windowStart: number
): string {
  return `rate_limit:burst:${identifier}:${windowStart}`;
}

export function generateSustainedKey(identifier: string): string {
  // Use a single key per identifier for sliding window tracking
  // The sliding window is managed via timestamps in the sorted set, not separate keys
  return `rate_limit:sustained:${identifier}`;
}

export function calculateRetryAfter(resetTime: number): number {
  const now = Date.now();
  const retryAfter = Math.ceil((resetTime - now) / 1000);
  return Math.max(1, retryAfter);
}

/** The one key shared by IPv6 addresses that cannot be parsed into groups. */
export const IPV6_UNPARSED_KEY = 'ipv6-unparsed';

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/** Splits one side of `::` into 16-bit groups; a dotted tail fills two. */
function ipv6PartGroups(part: string): number[] | null {
  if (!part) return [];
  const groups: number[] = [];
  const pieces = part.split(':');
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.includes('.')) {
      if (i !== pieces.length - 1 || isIP(piece) !== 4) return null;
      const [a, b, c, d] = piece.split('.').map(Number);
      groups.push(a * 256 + b, c * 256 + d);
    } else if (IPV6_GROUP.test(piece)) {
      groups.push(Number.parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}

/** The eight 16-bit groups of an IPv6 address without a zone id. */
function expandIpv6Groups(address: string): number[] | null {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = ipv6PartGroups(halves[0]);
  const tail = halves.length === 2 ? ipv6PartGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Node's own canonical form of an IPv6 address, or null. */
function canonicalIpv6(address: string): string | null {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : null;
  } catch {
    return null;
  }
}

/**
 * The rate limit key of an IPv6 address: its /64 prefix, or the IPv4
 * address an IPv4-mapped address (::ffff:a.b.c.d) carries. The zone id is
 * ignored. An address that cannot be parsed shares one key rather than
 * getting a bucket of its own.
 */
export function ipv6RateLimitKey(ip: string): string {
  const address = ip.split('%')[0];
  const fallback = canonicalIpv6(address);
  const groups =
    expandIpv6Groups(address) ??
    (fallback === null ? null : expandIpv6Groups(fallback));
  if (!groups) return IPV6_UNPARSED_KEY;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff
    ].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/**
 * The rate limit key for a source address. IPv4 addresses stay whole; IPv6
 * addresses are grouped by their /64 prefix, which is what a single
 * subscriber or host is normally assigned, so one network cannot spread
 * requests over many addresses of its own prefix.
 */
export function rateLimitAddressKey(ip: string): string {
  return isIP(ip) === 6 ? ipv6RateLimitKey(ip) : ip;
}

const SIGN_IN_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/auth\/nonce\/?$/i },
  { method: 'GET', path: /^\/api\/auth\/session-nonce\/?$/i },
  { method: 'POST', path: /^\/api\/auth\/login\/?$/i },
  { method: 'POST', path: /^\/api\/auth\/session-login\/?$/i }
];

/** Nonce and login requests, which share the tighter sign-in budget. */
export function isSignInRequest(method: string, path: string): boolean {
  const upperMethod = method.toUpperCase();
  return SIGN_IN_ROUTES.some(
    (route) => route.method === upperMethod && route.path.test(path)
  );
}

export function sanitizeIdentifier(identifier: string): string {
  // Remove any characters that could be problematic in Redis keys
  return identifier.replace(/[^a-zA-Z0-9:._-]/g, '_');
}

/**
 * Verifies a signed internal request using HMAC with timestamp
 * The web app should sign: HMAC-SHA256(secret, `${clientId}\n${timestamp}\n${method}\n${path}`)
 * @param req - Express request object
 * @param internalConfig - Internal configuration object with clientId and secret
 * @returns true if the signature is valid
 */
export function verifyInternalRequest(
  req: Request,
  internalConfig: {
    enabled: boolean;
    clientId: string | null;
    secret: string | null;
  }
): boolean {
  if (
    !internalConfig.enabled ||
    !internalConfig.clientId ||
    !internalConfig.secret
  ) {
    return false;
  }

  const clientId = req.headers['x-6529-internal-id'] as string | undefined;
  const timestamp = req.headers['x-6529-internal-timestamp'] as
    | string
    | undefined;
  const signature = req.headers['x-6529-internal-signature'] as
    | string
    | undefined;

  if (clientId !== internalConfig.clientId) {
    return false;
  }

  if (!timestamp || !signature) {
    return false;
  }

  const timestampNum = Number.parseInt(timestamp, 10);
  if (!timestampNum) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > 300) {
    return false;
  }

  try {
    // Use path with query string to match web app's pathname + search format
    // Uppercase method to match web app's .toUpperCase() call
    const pathWithQuery =
      req.path +
      (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
    const method = req.method.toUpperCase();
    const payload = `${clientId}\n${timestampNum}\n${method}\n${pathWithQuery}`;
    const expected = createHmac('sha256', internalConfig.secret)
      .update(payload)
      .digest('hex');

    const signatureBuffer = new Uint8Array(Buffer.from(signature, 'hex'));
    const expectedBuffer = new Uint8Array(Buffer.from(expected, 'hex'));
    return timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (error) {
    logger.error(`Error verifying internal request signature: ${error}`);
    return false;
  }
}
