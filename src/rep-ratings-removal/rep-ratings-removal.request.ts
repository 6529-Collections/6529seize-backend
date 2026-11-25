/**
 * The input of the one-off job that deletes one rater's REP ratings in some
 * categories. The rater and the categories come only from the invocation
 * payload: they are data, never code.
 */
export const REP_RATINGS_REMOVE_JOB = 'REP_RATINGS_REMOVE';

export enum RepRatingsRemovalMode {
  /** Changes nothing; reports what an APPLY run would remove. */
  DRY_RUN = 'DRY_RUN',
  APPLY = 'APPLY'
}

export const DEFAULT_BATCH_SIZE = 2000;
export const MAX_BATCH_SIZE = 5000;
/** A category must have more of the rater's ratings than this by default. */
export const DEFAULT_MIN_TARGETS_PER_CATEGORY = 2000;
export const MAX_CATEGORIES = 100;
/** The `ratings` key column widths. */
const MAX_PROFILE_ID_LENGTH = 50;
const MAX_CATEGORY_LENGTH = 100;
const MAX_HANDLE_LENGTH = 100;

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

const KNOWN_KEYS = new Set([
  'job',
  'mode',
  'rater_profile_id',
  'rater_handle',
  'matter',
  'categories',
  'batch_size',
  'min_targets_per_category',
  'not_after',
  'max_ratings'
]);

/** The rater, by profile id or by handle (resolved by the job). */
export type RaterRef =
  | { readonly profileId: string }
  | { readonly handle: string };

export interface RepRatingsRemovalRequest {
  readonly mode: RepRatingsRemovalMode;
  readonly rater: RaterRef;
  /** In the payload's order, no duplicates. */
  readonly categories: string[];
  readonly batchSize: number;
  /** Each category must have more of the rater's ratings than this. */
  readonly minTargetsPerCategory: number;
  /**
   * No batch starts at or after this time (Unix ms). Required for APPLY, so
   * a run can't change ratings after the snapshot it was meant to precede.
   */
  readonly notAfterMillis: number | null;
  /** This invocation stops after deleting this many ratings. */
  readonly maxRatings: number | null;
}

/** A request the job refuses: nothing has been changed. */
export class RepRatingsRemovalRefusal extends Error {
  constructor(message: string) {
    super(`[REP RATINGS REMOVAL REFUSED] ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'RepRatingsRemovalRefusal';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** True for an invocation addressed to this job (by its `job` field). */
export function isRepRatingsRemovalEvent(event: unknown): boolean {
  return isPlainObject(event) && event.job === REP_RATINGS_REMOVE_JOB;
}

function optionalInteger(
  payload: Record<string, unknown>,
  key: string,
  { min, max }: { min: number; max: number }
): number | null {
  const value = payload[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RepRatingsRemovalRefusal(
      `${key} must be an integer from ${min} to ${max}`
    );
  }
  return value;
}

function parseMode(value: unknown): RepRatingsRemovalMode {
  if (
    value !== RepRatingsRemovalMode.DRY_RUN &&
    value !== RepRatingsRemovalMode.APPLY
  ) {
    throw new RepRatingsRemovalRefusal(
      `mode must be ${RepRatingsRemovalMode.DRY_RUN} or ${RepRatingsRemovalMode.APPLY}`
    );
  }
  return value;
}

function isTrimmedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= maxLength
  );
}

function parseRater(payload: Record<string, unknown>): RaterRef {
  const profileId = payload.rater_profile_id;
  const handle = payload.rater_handle;
  if ((profileId === undefined) === (handle === undefined)) {
    throw new RepRatingsRemovalRefusal(
      'give exactly one of rater_profile_id and rater_handle'
    );
  }
  if (profileId !== undefined) {
    if (!isTrimmedString(profileId, MAX_PROFILE_ID_LENGTH)) {
      throw new RepRatingsRemovalRefusal(
        `rater_profile_id must be a profile id (1 to ${MAX_PROFILE_ID_LENGTH} characters, no surrounding spaces)`
      );
    }
    return { profileId };
  }
  if (!isTrimmedString(handle, MAX_HANDLE_LENGTH)) {
    throw new RepRatingsRemovalRefusal(
      `rater_handle must be a handle (1 to ${MAX_HANDLE_LENGTH} characters, no surrounding spaces)`
    );
  }
  return { handle: handle.toLowerCase() };
}

function parseCategories(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CATEGORIES
  ) {
    throw new RepRatingsRemovalRefusal(
      `categories must be a list of 1 to ${MAX_CATEGORIES} category names`
    );
  }
  const seen = new Set<string>();
  value.forEach((category, index) => {
    if (
      typeof category !== 'string' ||
      !category.trim().length ||
      category.length > MAX_CATEGORY_LENGTH
    ) {
      throw new RepRatingsRemovalRefusal(
        `categories[${index}] must be a category name of 1 to ${MAX_CATEGORY_LENGTH} characters`
      );
    }
    if (seen.has(category)) {
      throw new RepRatingsRemovalRefusal(
        `categories[${index}] is listed twice`
      );
    }
    seen.add(category);
  });
  return Array.from(seen);
}

function parseNotAfter(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const millis =
    typeof value === 'string' && ISO_UTC.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) {
    throw new RepRatingsRemovalRefusal(
      'not_after must be a UTC time such as 2026-01-01T00:00:00Z'
    );
  }
  return millis;
}

/**
 * The job's request from the invocation payload. Refuses unknown keys (a
 * misspelt option must not be ignored), a missing mode, both or neither of
 * the rater fields, an APPLY without not_after, and a matter other than REP.
 */
export function parseRepRatingsRemovalRequest(
  event: unknown
): RepRatingsRemovalRequest {
  if (!isRepRatingsRemovalEvent(event)) {
    throw new RepRatingsRemovalRefusal(
      `the payload's job must be ${REP_RATINGS_REMOVE_JOB}`
    );
  }
  const payload = event as Record<string, unknown>;
  const unknownKeys = Object.keys(payload).filter(
    (key) => !KNOWN_KEYS.has(key)
  );
  if (unknownKeys.length) {
    throw new RepRatingsRemovalRefusal(
      `unknown payload keys: ${unknownKeys.join(', ')}`
    );
  }
  if (payload.matter !== undefined && payload.matter !== 'REP') {
    throw new RepRatingsRemovalRefusal('matter must be REP');
  }
  const mode = parseMode(payload.mode);
  const notAfterMillis = parseNotAfter(payload.not_after);
  if (mode === RepRatingsRemovalMode.APPLY && notAfterMillis === null) {
    throw new RepRatingsRemovalRefusal(
      'not_after is required for APPLY: the time after which no batch starts'
    );
  }
  return {
    mode,
    rater: parseRater(payload),
    categories: parseCategories(payload.categories),
    batchSize:
      optionalInteger(payload, 'batch_size', { min: 1, max: MAX_BATCH_SIZE }) ??
      DEFAULT_BATCH_SIZE,
    minTargetsPerCategory:
      optionalInteger(payload, 'min_targets_per_category', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER
      }) ?? DEFAULT_MIN_TARGETS_PER_CATEGORY,
    notAfterMillis,
    maxRatings: optionalInteger(payload, 'max_ratings', {
      min: 1,
      max: Number.MAX_SAFE_INTEGER
    })
  };
}
