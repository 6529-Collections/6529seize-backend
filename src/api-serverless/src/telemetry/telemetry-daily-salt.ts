import { createHmac, randomBytes } from 'node:crypto';
import { getRedisClient } from '@/redis';

/**
 * Daily salt for the in-memory hashes used by telemetry (rate-limit keys and,
 * later, anonymous daily uniques).
 *
 * - Generated from a secure random source, shared across API instances
 *   through Redis memory only, and set to expire at the next UTC midnight.
 * - Never written to MySQL, files or logs. The in-process copy is wiped when
 *   the UTC day changes, so after rotation the old salt no longer exists and
 *   yesterday's hashes cannot be recomputed.
 * - When Redis is unavailable, a per-process salt is used for rate-limit keys
 *   only (`shared: false`); callers must not count uniques with it.
 */
export interface TelemetryDailySalt {
  readonly day: string;
  readonly salt: Buffer;
  readonly shared: boolean;
}

const SALT_KEY_PREFIX = 'telemetry:salt:';
const SALT_BYTES = 32;
const REDIS_TIMEOUT_MS = 250;

let current: TelemetryDailySalt | null = null;
let loading: { day: string; promise: Promise<Buffer | null> } | null = null;

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcMidnightEpochSeconds(now: Date): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return Math.floor(next / 1000);
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('telemetry salt redis timeout')),
      REDIS_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadSharedSalt(day: string, now: Date): Promise<Buffer | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    return null;
  }
  const key = `${SALT_KEY_PREFIX}${day}`;
  try {
    await withTimeout(
      redis.set(key, randomBytes(SALT_BYTES).toString('base64'), {
        NX: true,
        EXAT: nextUtcMidnightEpochSeconds(now)
      })
    );
    const value = await withTimeout(redis.get(key));
    return typeof value === 'string' && value.length > 0
      ? Buffer.from(value, 'base64')
      : null;
  } catch {
    return null;
  }
}

function destroyCurrent() {
  current?.salt.fill(0);
  current = null;
}

function loadSharedSaltOnce(day: string, now: Date): Promise<Buffer | null> {
  if (loading?.day !== day) {
    const promise = loadSharedSalt(day, now).finally(() => {
      if (loading?.promise === promise) {
        loading = null;
      }
    });
    loading = { day, promise };
  }
  return loading.promise;
}

export async function getTelemetryDailySalt(
  now: Date = new Date()
): Promise<TelemetryDailySalt> {
  const day = utcDay(now);
  if (current && current.day !== day) {
    // UTC midnight: the previous salt is wiped and can never be used again.
    destroyCurrent();
  }
  if (current?.shared) {
    return current;
  }
  const shared = await loadSharedSaltOnce(day, now);
  if (current?.day === day && current.shared) {
    return current;
  }
  if (shared) {
    // Replaces at most a same-day per-process fallback, which was never
    // used to count uniques; it is dropped rather than wiped in case an
    // in-flight request still holds it.
    current = { day, salt: shared, shared: true };
    return current;
  }
  if (current?.day !== day) {
    current = { day, salt: randomBytes(SALT_BYTES), shared: false };
  }
  return current;
}

/** HMAC-SHA256 of the parts under the daily salt, hex encoded. */
export function telemetryDailyHash(
  salt: TelemetryDailySalt,
  ...parts: readonly string[]
): string {
  return createHmac('sha256', salt.salt)
    .update(parts.join('\u0000'))
    .digest('hex');
}

/** Test hook: forget the in-process salt. */
export function resetTelemetryDailySaltForTests() {
  destroyCurrent();
  loading = null;
}
