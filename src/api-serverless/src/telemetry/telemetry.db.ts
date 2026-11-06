import {
  ANALYTICS_DAILY_TABLE,
  HEALTH_DAILY_TABLE,
  VITALS_DAILY_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  AnalyticsIncrement,
  HealthIncrement,
  TelemetryIncrements,
  VitalsIncrement
} from '@/api/telemetry/telemetry-aggregation';

const TELEMETRY_TABLES = [
  ANALYTICS_DAILY_TABLE,
  VITALS_DAILY_TABLE,
  HEALTH_DAILY_TABLE
] as const;
const RETENTION_DELETE_BATCH = 5000;
const RETENTION_MAX_BATCHES_PER_TABLE = 20;

type Row = Record<string, string | number>;

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * One multi-row upsert that adds to existing counters. Rows are sorted by
 * primary key so concurrent writers lock rows in the same order.
 */
async function upsertCounters(
  table: string,
  columns: readonly string[],
  rows: readonly Row[],
  sortKey: (row: Row) => string
) {
  if (rows.length === 0) {
    return;
  }
  const sorted = [...rows].sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
  const params: Record<string, string | number> = {};
  const values = sorted.map((row, index) => {
    const placeholders = columns.map((column) => {
      params[`${column}_${index}`] = row[column];
      return `:${column}_${index}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  await sqlExecutor.execute(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES ${values.join(', ')}
     ON DUPLICATE KEY UPDATE count = count + VALUES(count)`,
    params
  );
}

function analyticsRow(day: string, row: AnalyticsIncrement): Row {
  return {
    day,
    hour: row.hour,
    kind: row.kind,
    dims_key: row.dims_key,
    ...row.dims,
    count: row.count
  };
}

function vitalsRow(day: string, row: VitalsIncrement): Row {
  return { day, ...row };
}

function healthRow(day: string, row: HealthIncrement): Row {
  return { day, ...row };
}

export async function writeTelemetryIncrements(
  day: string,
  increments: TelemetryIncrements
): Promise<void> {
  await upsertCounters(
    ANALYTICS_DAILY_TABLE,
    [
      'day',
      'hour',
      'kind',
      'dims_key',
      'name',
      'route',
      'prev_route',
      'page_group',
      'referrer_domain',
      'device',
      'platform',
      'browser',
      'signed_in',
      'country',
      'props',
      'count'
    ],
    increments.analytics.map((row) => analyticsRow(day, row)),
    (row) => `${row.hour}|${row.kind}|${row.dims_key}`
  );
  await upsertCounters(
    VITALS_DAILY_TABLE,
    ['day', 'route', 'device', 'platform', 'metric', 'bucket', 'count'],
    increments.vitals.map((row) => vitalsRow(day, row)),
    (row) =>
      `${row.route}|${row.device}|${row.platform}|${row.metric}|${String(row.bucket).padStart(4, '0')}`
  );
  await upsertCounters(
    HEALTH_DAILY_TABLE,
    ['day', 'route', 'platform', 'counter', 'dim', 'count'],
    increments.health.map((row) => healthRow(day, row)),
    (row) => `${row.route}|${row.platform}|${row.counter}|${row.dim}`
  );
}

/**
 * Deletes daily rows older than the cutoff day (inclusive bound kept) in
 * small batches. Returns the number of rows removed.
 */
export async function deleteTelemetryRowsBefore(
  cutoffDay: string
): Promise<number> {
  let removed = 0;
  for (const table of TELEMETRY_TABLES) {
    for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
      const result = await sqlExecutor.execute(
        `DELETE FROM ${table} WHERE day < :cutoffDay ORDER BY day LIMIT ${RETENTION_DELETE_BATCH}`,
        { cutoffDay }
      );
      const affected = sqlExecutor.getAffectedRows(result);
      removed += affected;
      if (affected < RETENTION_DELETE_BATCH) {
        break;
      }
    }
  }
  return removed;
}
