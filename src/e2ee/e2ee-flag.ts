type Env = Readonly<Record<string, string | undefined>>;

/** `'true'` or `'false'` (any case, trimmed); null when unset or anything else. */
function readBooleanFlag(env: Env, name: string): boolean | null {
  const flag = env[name]?.trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return null;
}

/** `local` and `development` (staging); production and everything else is not. */
function isDevelopmentLike(env: Env): boolean {
  return env.NODE_ENV === 'local' || env.NODE_ENV === 'development';
}

/**
 * `E2EE_DMS_ENABLED`: `'true'` turns encrypted messaging on and `'false'`
 * turns it off. When unset it is on for `local` and `development` (staging)
 * and off everywhere else, including production.
 */
export function isE2eeEnabled(env: Env = process.env): boolean {
  return readBooleanFlag(env, 'E2EE_DMS_ENABLED') ?? isDevelopmentLike(env);
}

/**
 * `E2EE_ATTACHMENTS_ENABLED`: a kill switch for the encrypted attachment
 * (blob) routes. On unless it is exactly `'false'`, in every environment
 * including production; `'false'` makes them refuse before any database
 * access.
 */
export function isE2eeAttachmentsEnabled(env: Env = process.env): boolean {
  return readBooleanFlag(env, 'E2EE_ATTACHMENTS_ENABLED') ?? true;
}

/**
 * `E2EE_BACKUPS_ENABLED`: a kill switch for the encrypted message-history
 * backup routes (which also need `E2EE_DMS_ENABLED`). On unless it is
 * exactly `'false'`; `'false'` makes them refuse before any database access.
 */
export function isE2eeBackupsEnabled(env: Env = process.env): boolean {
  return readBooleanFlag(env, 'E2EE_BACKUPS_ENABLED') ?? true;
}

/** P35's value; staging allows more so automated tests can churn groups. */
const PRODUCTION_ENTRIES_PER_GROUP_PER_HOUR = 12;
const DEVELOPMENT_ENTRIES_PER_GROUP_PER_HOUR = 30;
const MAX_ENTRIES_PER_GROUP_PER_HOUR = 1000;

/**
 * Commits and proposals one group may sequence per hour.
 * `E2EE_ENTRIES_PER_GROUP_PER_HOUR` (an integer from 1 to 1000) overrides
 * the default: 12 in production, 30 in `local` and `development`.
 */
export function e2eeEntriesPerGroupPerHour(env: Env = process.env): number {
  const raw = env.E2EE_ENTRIES_PER_GROUP_PER_HOUR?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value >= 1 && value <= MAX_ENTRIES_PER_GROUP_PER_HOUR) return value;
  }
  return isDevelopmentLike(env)
    ? DEVELOPMENT_ENTRIES_PER_GROUP_PER_HOUR
    : PRODUCTION_ENTRIES_PER_GROUP_PER_HOUR;
}

/**
 * `E2EE_TRUST_AND_SAFETY_GROUP_ID`: the user group whose members may read
 * reported encrypted messages. It is separate from wave moderators and from
 * the general moderation queue. While unset, nobody can read reports; they
 * are still stored.
 */
export function e2eeTrustAndSafetyGroupId(
  env: Env = process.env
): string | null {
  const value = env.E2EE_TRUST_AND_SAFETY_GROUP_ID?.trim();
  return value || null;
}
