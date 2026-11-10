import * as jwt from 'jsonwebtoken';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import {
  canUseLocalNonceReplayFallback,
  isStructuredWalletSignatureMessage
} from '@/api/wallet-signatures/structured-wallet-signatures';

/**
 * Challenges for the plain-text sign-in (`GET /auth/nonce`, then
 * `POST /auth/login`). The server signature is a JWT whose payload names the
 * challenge type and the text to sign; it expires after
 * AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS (five minutes by default) and signs
 * in once.
 *
 * Builds before this one signed the text itself as the JWT payload, with no
 * expiry. Such a challenge is still accepted, once, during a short
 * transition so that a sign-in started just before a deploy can finish. The
 * transition starts when this build first runs (recorded in Redis, so every
 * instance shares it) and lasts STRING_FORM_TRANSITION_MS. Nothing has to be
 * configured for it, and from STRING_FORM_LAST_ACCEPTED_AT_MS on the old
 * form is refused whatever Redis holds.
 */

const logger = Logger.get('LEGACY_TEXT_CHALLENGE');

export const LEGACY_TEXT_CHALLENGE_TYPE = 'legacy_nonce';
export const DEFAULT_LEGACY_TEXT_CHALLENGE_TTL_SECONDS = 5 * 60;
export const MIN_LEGACY_TEXT_CHALLENGE_TTL_SECONDS = 60;
export const MAX_LEGACY_TEXT_CHALLENGE_TTL_SECONDS = 60 * 60;
export const STRING_FORM_TRANSITION_MS = 15 * 60 * 1000;
/** 2026-11-17T00:00:00Z. */
export const STRING_FORM_LAST_ACCEPTED_AT_MS = Date.UTC(2026, 10, 17);
const STRING_FORM_TRANSITION_KEY =
  'auth_legacy_text_challenge_string_form_until';
const STRING_FORM_TRANSITION_KEY_EXTRA_MS = 24 * 60 * 60 * 1000;
const JWT_ALGORITHM = 'HS256';

let localStringFormAcceptedUntilMs: number | null = null;

export type LegacyTextChallengeForm = 'expiring' | 'string';

/** How a `/auth/login` challenge arrived, for usage metrics. */
export type LegacyLoginFormat =
  | 'text'
  | 'text_previous_form'
  | 'structured'
  | 'unverified';

export interface LegacyLoginChallenge {
  /** The message the wallet signed. */
  readonly message: string;
  readonly form: LegacyTextChallengeForm;
  /**
   * When the challenge stops being accepted: its expiry, or for the old
   * string form the last day that form is accepted.
   */
  readonly expiresAtMs: number;
}

export function isLegacyTextLoginDisabled(): boolean {
  return process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED === 'true';
}

/**
 * Lifetime of a new plain-text challenge in seconds:
 * AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS clamped to 60-3600, so operations
 * can give slow signers (multi-owner contract wallets) more time without a
 * deploy. Unset or not a whole number means 300. Never throws.
 */
export function getLegacyTextChallengeTtlSeconds(): number {
  const text = process.env.AUTH_LEGACY_TEXT_CHALLENGE_TTL_SECONDS?.trim();
  if (!text || !/^\d+$/.test(text)) {
    return DEFAULT_LEGACY_TEXT_CHALLENGE_TTL_SECONDS;
  }
  return Math.min(
    MAX_LEGACY_TEXT_CHALLENGE_TTL_SECONDS,
    Math.max(MIN_LEGACY_TEXT_CHALLENGE_TTL_SECONDS, Number(text))
  );
}

export function signLegacyTextChallenge(
  message: string,
  jwtSecret: string
): string {
  return jwt.sign(
    { challenge_type: LEGACY_TEXT_CHALLENGE_TYPE, nonce: message },
    jwtSecret,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn: getLegacyTextChallengeTtlSeconds()
    }
  );
}

/**
 * Verifies a `/auth/login` server signature: an expiring plain-text
 * challenge, or a JWT whose payload is the signed message itself (the old
 * plain-text form, and the structured messages of `/auth/session-nonce`).
 * Throws for anything else, including expired tokens and other token types
 * signed with the same secret.
 */
export function verifyLegacyLoginChallengeToken(
  token: string,
  jwtSecret: string
): LegacyLoginChallenge {
  const payload = jwt.verify(token, jwtSecret, {
    algorithms: [JWT_ALGORITHM]
  });
  if (typeof payload === 'string') {
    if (payload.length === 0) {
      throw new Error('Invalid server signature');
    }
    return {
      message: payload,
      form: 'string',
      expiresAtMs: STRING_FORM_LAST_ACCEPTED_AT_MS
    };
  }
  const { challenge_type, nonce, exp } = payload;
  if (
    challenge_type !== LEGACY_TEXT_CHALLENGE_TYPE ||
    typeof nonce !== 'string' ||
    nonce.length === 0 ||
    typeof exp !== 'number'
  ) {
    throw new Error('Invalid server signature');
  }
  return { message: nonce, form: 'expiring', expiresAtMs: exp * 1000 };
}

export function legacyLoginFormatOf(
  challenge: LegacyLoginChallenge
): LegacyLoginFormat {
  if (isStructuredWalletSignatureMessage(challenge.message)) {
    return 'structured';
  }
  return challenge.form === 'expiring' ? 'text' : 'text_previous_form';
}

/**
 * Whether a plain-text challenge in the old string form is still accepted.
 * Starts the transition if no instance has yet. Refused when the transition
 * cannot be read (Redis unavailable outside local and test runs), the same
 * fail-closed rule as nonce consumption.
 */
export async function isStringFormChallengeAccepted(
  nowMs: number = Date.now()
): Promise<boolean> {
  if (nowMs >= STRING_FORM_LAST_ACCEPTED_AT_MS) {
    return false;
  }
  const acceptedUntilMs = await readOrStartStringFormTransition(nowMs);
  return acceptedUntilMs !== null && nowMs < acceptedUntilMs;
}

/**
 * Starts the transition for old string-form challenges unless it has already
 * started. Called when the API starts, so the transition begins with the
 * deploy rather than with the first old challenge presented. Never throws.
 */
export async function startStringFormTransition(
  nowMs: number = Date.now()
): Promise<void> {
  if (nowMs >= STRING_FORM_LAST_ACCEPTED_AT_MS) {
    return;
  }
  await readOrStartStringFormTransition(nowMs);
}

export function resetStringFormTransitionForTests(): void {
  localStringFormAcceptedUntilMs = null;
}

async function readOrStartStringFormTransition(
  nowMs: number
): Promise<number | null> {
  const proposedUntilMs = Math.min(
    nowMs + STRING_FORM_TRANSITION_MS,
    STRING_FORM_LAST_ACCEPTED_AT_MS
  );
  const redis = getRedisClient();
  if (!redis) {
    return readOrStartLocalTransition(proposedUntilMs);
  }
  try {
    await redis.set(STRING_FORM_TRANSITION_KEY, String(proposedUntilMs), {
      NX: true,
      EX: Math.ceil(
        (STRING_FORM_LAST_ACCEPTED_AT_MS +
          STRING_FORM_TRANSITION_KEY_EXTRA_MS -
          nowMs) /
          1000
      )
    });
    const stored = Number(await redis.get(STRING_FORM_TRANSITION_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch (error) {
    logger.error('Sign-in challenge transition check failed', error);
    return readOrStartLocalTransition(proposedUntilMs);
  }
}

function readOrStartLocalTransition(proposedUntilMs: number): number | null {
  if (!canUseLocalNonceReplayFallback()) {
    return null;
  }
  localStringFormAcceptedUntilMs ??= proposedUntilMs;
  return localStringFormAcceptedUntilMs;
}
