import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { deleteTelemetryRowsBefore } from '@/api/telemetry/telemetry.db';
import { deleteExpiredDiagnostics } from '@/api/telemetry/telemetry-diagnostics.db';
import { utcDay } from '@/api/telemetry/telemetry-daily-salt';
import {
  previousUtcDay,
  rollUpSignedInActives
} from '@/api/telemetry/telemetry-actives';
import { finalizeAnonymousVisitors } from '@/api/telemetry/telemetry-uniques';

const logger = Logger.get('TELEMETRY_DAILY_JOBS');
export const TELEMETRY_RETENTION_MONTHS = 25;
const LOCK_KEY_PREFIX = 'telemetry:daily-jobs:';
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
    // Without Redis each instance runs the cheap jobs once per day.
    return true;
  }
  const result = await redis.set(`${LOCK_KEY_PREFIX}${day}`, '1', {
    NX: true,
    EX: LOCK_TTL_SECONDS
  });
  return result === 'OK';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

async function runJob(name: string, job: () => Promise<void>) {
  try {
    await job();
  } catch (error) {
    logger.warn(`Telemetry daily job ${name} failed: ${errorName(error)}`);
  }
}

/**
 * Lazy daily jobs: the first collector request of each UTC day (across all
 * instances, coordinated through a Redis lock) stores yesterday's signed-in
 * actives, deletes diagnostics bundles past their 14 days (uploads also
 * delete expired ones) and removes rows older than the 25-month retention
 * window. No
 * scheduler of its own is needed because the collector receives traffic
 * every day.
 */
export async function maybeRunTelemetryDailyJobs(
  now: Date = new Date()
): Promise<void> {
  const day = utcDay(now);
  if (lastRunDay === day) {
    return;
  }
  lastRunDay = day;
  let acquired = false;
  try {
    acquired = await acquireDailyLock(day);
  } catch (error) {
    logger.warn(`Telemetry daily job lock failed: ${errorName(error)}`);
  }
  if (!acquired) {
    return;
  }
  const yesterday = previousUtcDay(now);
  await runJob('anonymous-visitors', () =>
    finalizeAnonymousVisitors(yesterday)
  );
  await runJob('actives', () => rollUpSignedInActives(yesterday));
  await runJob('diagnostics', async () => {
    const removed = await deleteExpiredDiagnostics(now);
    logger.info(`Telemetry removed ${removed} expired diagnostics bundles`);
  });
  await runJob('retention', async () => {
    const removed = await deleteTelemetryRowsBefore(
      telemetryRetentionCutoffDay(now)
    );
    logger.info(`Telemetry retention removed ${removed} daily rows`);
  });
}

export function resetTelemetryDailyJobsForTests() {
  lastRunDay = null;
}
