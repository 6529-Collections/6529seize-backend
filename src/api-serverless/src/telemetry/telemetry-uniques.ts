import { getRedisClient } from '@/redis';
import { TelemetryEvent } from '@/api/telemetry/telemetry-sanitizer';
import {
  nextUtcMidnightEpochSeconds,
  TelemetryDailySalt,
  telemetryDailyHash,
  utcDay
} from '@/api/telemetry/telemetry-daily-salt';
import { TelemetryViewer } from '@/api/telemetry/telemetry-edge';
import { upsertUniquesDailyMax } from '@/api/telemetry/telemetry-uniques.db';

/**
 * Anonymous daily unique visitors (C52 D2, amended by C52a).
 *
 * For each page view the server computes, in memory,
 *   HMAC(daily_salt, ip, browser_family, fp)   when the client sent `fp`,
 *   HMAC(daily_salt, ip, browser_family)       otherwise (EU/EEA/UK/unknown),
 * adds the result to a per-day Redis HyperLogLog and discards it. The HLL
 * keeps only register maxima, not the hashes, so no visitor value can be read
 * back. The IP, `fp` and hash are never stored or logged, and the salt is
 * destroyed at UTC midnight, so the next day's hashes cannot be linked to
 * today's. Only the daily count is persisted (uniques_daily).
 */
export const ANONYMOUS_VISITORS_METRIC = 'anonymous_visitors';
const HLL_KEY_PREFIX = 'telemetry:uniq:';
// Kept a few hours past midnight so the final count of the day can be read.
const HLL_GRACE_SECONDS = 6 * 60 * 60;
const FLUSH_LOCK_KEY = 'telemetry:uniq-flush';
const FLUSH_INTERVAL_SECONDS = 5 * 60;
const REDIS_TIMEOUT_MS = 250;

let lastFlushAttemptMs = 0;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('telemetry uniques redis timeout')),
      REDIS_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function anonymousVisitorHash(
  salt: TelemetryDailySalt,
  ip: string,
  browser: string,
  fp: string | null
): string {
  return fp
    ? telemetryDailyHash(salt, 'visitor-fp', ip, browser, fp)
    : telemetryDailyHash(salt, 'visitor', ip, browser);
}

function hllKey(day: string): string {
  return `${HLL_KEY_PREFIX}${day}`;
}

/**
 * Counts the page views' visitors in today's HyperLogLog. Skipped when the
 * IP is unknown or the salt is not shared across instances (a per-process
 * salt would count the same visitor once per instance).
 */
export async function recordAnonymousVisitors(
  events: readonly TelemetryEvent[],
  viewer: TelemetryViewer,
  salt: TelemetryDailySalt,
  now: Date
): Promise<void> {
  const redis = getRedisClient();
  if (!viewer.ip || !salt.shared || !redis?.isReady) {
    return;
  }
  const hashes = new Set<string>();
  for (const event of events) {
    if (event.t === 'pv') {
      hashes.add(
        anonymousVisitorHash(salt, viewer.ip, event.browser, event.fp)
      );
    }
  }
  if (hashes.size === 0) {
    return;
  }
  const key = hllKey(salt.day);
  await withTimeout(redis.pfAdd(key, Array.from(hashes)));
  await withTimeout(
    redis.expireAt(key, nextUtcMidnightEpochSeconds(now) + HLL_GRACE_SECONDS)
  );
}

async function readCount(day: string): Promise<number | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    return null;
  }
  const count = await withTimeout(redis.pfCount(hllKey(day)));
  return typeof count === 'number' ? count : null;
}

async function acquireFlushLock(): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    return false;
  }
  const result = await withTimeout(
    redis.set(FLUSH_LOCK_KEY, '1', { NX: true, EX: FLUSH_INTERVAL_SECONDS })
  );
  return result === 'OK';
}

/**
 * At most every five minutes (across instances), persist today's count, and
 * yesterday's final count during the first hours after midnight. Counts only
 * grow, so a late or repeated flush never lowers a stored value.
 */
export async function maybeFlushAnonymousVisitors(now: Date): Promise<void> {
  const nowMs = now.getTime();
  if (nowMs - lastFlushAttemptMs < FLUSH_INTERVAL_SECONDS * 1000) {
    return;
  }
  lastFlushAttemptMs = nowMs;
  if (!(await acquireFlushLock())) {
    return;
  }
  const today = utcDay(now);
  const days = [today];
  const yesterday = utcDay(new Date(nowMs - 24 * 60 * 60 * 1000));
  if (now.getUTCHours() * 3600 < HLL_GRACE_SECONDS) {
    days.push(yesterday);
  }
  for (const day of days) {
    const count = await readCount(day);
    if (count !== null && count > 0) {
      await upsertUniquesDailyMax(day, ANONYMOUS_VISITORS_METRIC, count);
    }
  }
}

/** Live count for today (not yet flushed), or null without Redis. */
export async function readTodayAnonymousVisitors(
  now: Date
): Promise<number | null> {
  return readCount(utcDay(now));
}

export function resetTelemetryUniquesForTests() {
  lastFlushAttemptMs = 0;
}
