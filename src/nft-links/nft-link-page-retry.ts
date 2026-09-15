import { createHash, randomInt } from 'node:crypto';
import type { NftLinkEntity } from '@/entities/INftLink';
import type { CanonicalLink } from './types';
import { HttpError } from './lib/http';

const DELAYS = [5, 15, 60].map((minutes) => minutes * 60_000);
const CODE = 'REQUIRED_PAGE_HTTP_404';

export interface NftLinkPageRetryState {
  version: 1;
  code: typeof CODE;
  streak: number;
  attemptedAt: number;
  notBefore: number;
  scopeHash: string;
}

type RetryRow = Pick<NftLinkEntity, 'refresh_retry_state'> & {
  last_tried_to_update: number | string | null;
  last_successfully_updated: number | string | null;
  failed_since: number | string | null;
};

/** Raw worker TypeORM queries return BIGINT strings; API queries return numbers. */
function readRetryTimestamp(value: unknown): number | null {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+$/.test(value))
  )
    return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

/** Purpose is assigned only at a required canonical-page fetch, never from text. */
export class RequiredNftPageNotFoundError extends Error {
  constructor(public readonly scopeHash: string) {
    super('Required NFT canonical page returned HTTP 404');
    Object.setPrototypeOf(this, RequiredNftPageNotFoundError.prototype);
  }
}

export function nftPageRetryScope(canonical: CanonicalLink): string {
  return createHash('sha256')
    .update(JSON.stringify([1, CODE, canonical.canonicalId, canonical.viewUrl]))
    .digest('hex');
}

export function requiredNftPage404(
  error: unknown,
  canonical: CanonicalLink
): RequiredNftPageNotFoundError | null {
  if (
    !['TRANSIENT', 'MANIFOLD'].includes(canonical.platform) ||
    !(error instanceof HttpError) ||
    error.status !== 404 ||
    error.url !== canonical.viewUrl ||
    (!error.responseMatchesRequest &&
      (canonical.platform !== 'TRANSIENT' ||
        !error.responseMatchesTransientWwwAlias))
  )
    return null;
  return new RequiredNftPageNotFoundError(nftPageRetryScope(canonical));
}

function parseState(value: unknown): Partial<NftLinkPageRetryState> | null {
  try {
    const parsed: unknown =
      typeof value === 'string' ? JSON.parse(value) : value;
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Partial<NftLinkPageRetryState>)
      : null;
  } catch {
    return null;
  }
}

export function readNftPageRetryState(
  row: RetryRow,
  scopeHash: string
): NftLinkPageRetryState | null {
  const state = parseState(row.refresh_retry_state);
  const lastSuccess = readRetryTimestamp(row.last_successfully_updated);
  if (
    state?.version !== 1 ||
    state.code !== CODE ||
    state.scopeHash !== scopeHash ||
    !Number.isSafeInteger(state.streak) ||
    state.streak! < 1 ||
    state.streak! > 3 ||
    !Number.isSafeInteger(state.attemptedAt) ||
    state.attemptedAt! <= 0 ||
    !Number.isSafeInteger(state.notBefore) ||
    state.notBefore! < state.attemptedAt! + DELAYS[state.streak! - 1] * 0.9 ||
    state.notBefore! > state.attemptedAt! + DELAYS[state.streak! - 1] ||
    state.attemptedAt !== readRetryTimestamp(row.last_tried_to_update) ||
    readRetryTimestamp(row.failed_since) === null ||
    (row.last_successfully_updated != null && lastSuccess === null) ||
    (lastSuccess ?? 0) >= state.attemptedAt!
  )
    return null;
  return state as NftLinkPageRetryState;
}

/** A stale/legacy writer's new attempt timestamp invalidates old policy state. */
export function isNftLinkRefreshDue(
  row: RetryRow,
  canonical: CanonicalLink,
  now: number,
  ordinaryInterval: number
): boolean {
  const lastAttempt = readRetryTimestamp(row.last_tried_to_update);
  if (lastAttempt !== null && lastAttempt + ordinaryInterval >= now)
    return false;
  const state = readNftPageRetryState(row, nftPageRetryScope(canonical));
  return !state || state.attemptedAt > now || state.notBefore <= now;
}

export function nextNftPageRetryState(
  row: RetryRow,
  scopeHash: string,
  now: number,
  random = randomInt(1_000_000) / 1_000_000
): NftLinkPageRetryState {
  const previous = readNftPageRetryState(row, scopeHash);
  const streak = Math.min((previous?.streak ?? 0) + 1, DELAYS.length);
  // Negative jitter keeps the configured ceiling at one hour.
  const fraction = Number.isFinite(random)
    ? Math.max(0, Math.min(1, random))
    : 1;
  const delay = Math.ceil(DELAYS[streak - 1] * (0.9 + 0.1 * fraction));
  return {
    version: 1,
    code: CODE,
    streak,
    attemptedAt: now,
    notBefore: now + delay,
    scopeHash
  };
}
