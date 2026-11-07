import {
  ADDRESS_CONSOLIDATION_KEY,
  METRIC_ROLLUP_HOUR_TABLE,
  UNIQUES_DAILY_TABLE,
  WALLET_AUTH_SESSIONS_TABLE
} from '@/constants';
import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import { sqlExecutor } from '@/sql-executor';

/** Stores a daily count, keeping the larger of the stored and new values. */
export async function upsertUniquesDailyMax(
  day: string,
  metric: string,
  count: number
): Promise<void> {
  await sqlExecutor.execute(
    `INSERT INTO ${UNIQUES_DAILY_TABLE} (day, metric, count, updated_at)
     VALUES (:day, :metric, :count, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       count = GREATEST(count, VALUES(count)),
       updated_at = CURRENT_TIMESTAMP(3)`,
    { day, metric, count }
  );
}

/** Stores a daily count, replacing any earlier value for that day. */
export async function replaceUniquesDaily(
  day: string,
  metric: string,
  count: number
): Promise<void> {
  await sqlExecutor.execute(
    `INSERT INTO ${UNIQUES_DAILY_TABLE} (day, metric, count, updated_at)
     VALUES (:day, :metric, :count, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       count = VALUES(count),
       updated_at = CURRENT_TIMESTAMP(3)`,
    { day, metric, count }
  );
}

function toCount(rows: { count?: unknown }[]): number {
  return Number(rows[0]?.count ?? 0);
}

/**
 * Distinct signed-in identities whose wallet session was used (sign-in or
 * session refresh) in [start, end). Wallets of one consolidation count once.
 */
export async function countSignedInIdentities(
  start: Date,
  end: Date
): Promise<number> {
  const rows = await sqlExecutor.execute<{ count: number | string }>(
    `SELECT COUNT(DISTINCT COALESCE(ack.consolidation_key, LOWER(s.address))) AS count
     FROM ${WALLET_AUTH_SESSIONS_TABLE} s
     LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack ON ack.address = LOWER(s.address)
     WHERE s.last_used_at >= :start AND s.last_used_at < :end`,
    { start, end }
  );
  return toCount(rows);
}

/**
 * Distinct identities with authenticated write activity (drops, reactions,
 * votes, waves, groups) in [start, end), from the existing hourly
 * ACTIVE_IDENTITY rollup.
 */
export async function countActiveProfiles(
  start: Date,
  end: Date
): Promise<number> {
  const rows = await sqlExecutor.execute<{ count: number | string }>(
    `SELECT COUNT(DISTINCT scope) AS count
     FROM ${METRIC_ROLLUP_HOUR_TABLE}
     WHERE metric = :metric AND hour_start >= :start AND hour_start < :end`,
    { metric: MetricRollupHourMetric.ACTIVE_IDENTITY, start, end }
  );
  return toCount(rows);
}
