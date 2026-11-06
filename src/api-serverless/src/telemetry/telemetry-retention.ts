import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { deleteTelemetryRowsBefore } from '@/api/telemetry/telemetry.db';
import { utcDay } from '@/api/telemetry/telemetry-daily-salt';

const logger = Logger.get('TELEMETRY_RETENTION');
export const TELEMETRY_RETENTION_MONTHS = 25;
const LOCK_KEY_PREFIX = 'telemetry:retention:';
const LOCK_TTL_SECONDS = 26 * 60 * 60;

let lastRunDay: string | null = null;

/**
 * First day that is kept: the same calendar day 25 months earlier (UTC),
 * clamped to the last day of that month (Mar 31 -> Feb 28/29).
 */
export function telemetryRetentionCutoffDay(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - TELEMETRY_RETENTION_MONTHS;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return utcDay(
    new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDayOfMonth)))
  );
}

async function acquireDailyLock(day: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    // Without Redis each instance runs the cheap sweep once per day.
    return true;
  }
  const result = await redis.set(`${LOCK_KEY_PREFIX}${day}`, '1', {
    NX: true,
    EX: LOCK_TTL_SECONDS
  });
  return result === 'OK';
}

/**
 * Lazy daily sweep: the first collector request of each UTC day (across all
 * instances, coordinated through a Redis lock) removes rows older than the
 * 25-month retention window. It needs no scheduler of its own because the
 * collector receives traffic every day.
 */
export async function maybeRunTelemetryRetention(
  now: Date = new Date()
): Promise<void> {
  const day = utcDay(now);
  if (lastRunDay === day) {
    return;
  }
  lastRunDay = day;
  try {
    if (!(await acquireDailyLock(day))) {
      return;
    }
    const removed = await deleteTelemetryRowsBefore(
      telemetryRetentionCutoffDay(now)
    );
    logger.info(`Telemetry retention removed ${removed} daily rows`);
  } catch (error) {
    logger.warn(
      `Telemetry retention sweep failed: ${(error as Error)?.name ?? 'Error'}`
    );
  }
}

export function resetTelemetryRetentionForTests() {
  lastRunDay = null;
}
