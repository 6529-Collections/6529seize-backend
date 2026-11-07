import {
  ANALYTICS_DAILY_TABLE,
  HEALTH_DAILY_TABLE,
  UNIQUES_DAILY_TABLE,
  VITALS_DAILY_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  AnalyticsKind,
  DAILY_HOUR
} from '@/api/telemetry/telemetry-aggregation';

/** Day range, inclusive, as `YYYY-MM-DD`. */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export type CellRow = Record<string, string | number>;

const ANALYTICS_DIMENSIONS = new Set([
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
  'day',
  'hour'
]);

function dimensionList(dimensions: readonly string[]): string {
  for (const dimension of dimensions) {
    if (!ANALYTICS_DIMENSIONS.has(dimension)) {
      throw new Error(`Unknown analytics dimension ${dimension}`);
    }
  }
  return dimensions
    .map((dimension) =>
      dimension === 'day' ? `DATE_FORMAT(day, '%Y-%m-%d') AS day` : dimension
    )
    .join(', ');
}

function groupList(dimensions: readonly string[]): string {
  return dimensions
    .map((dimension) =>
      dimension === 'day' ? `DATE_FORMAT(day, '%Y-%m-%d')` : dimension
    )
    .join(', ');
}

/**
 * Sums one counter cube over the range, grouped by the given dimensions.
 * Rows are returned unsuppressed; callers apply the small-cell rule.
 */
export async function fetchAnalyticsCells(
  kind: AnalyticsKind,
  range: DayRange,
  dimensions: readonly string[]
): Promise<CellRow[]> {
  const hourFilter = kind === AnalyticsKind.EV ? '' : 'AND hour = :dailyHour';
  return sqlExecutor.execute<CellRow>(
    `SELECT ${dimensionList(dimensions)}, SUM(count) AS count
     FROM ${ANALYTICS_DAILY_TABLE}
     WHERE kind = :kind AND day BETWEEN :from AND :to ${hourFilter}
     GROUP BY ${groupList(dimensions)}`,
    { kind, from: range.from, to: range.to, dailyHour: DAILY_HOUR }
  );
}

export async function fetchUniquesDaily(range: DayRange): Promise<CellRow[]> {
  return sqlExecutor.execute<CellRow>(
    `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, metric, count
     FROM ${UNIQUES_DAILY_TABLE}
     WHERE day BETWEEN :from AND :to`,
    { from: range.from, to: range.to }
  );
}

export async function fetchVitalsBuckets(range: DayRange): Promise<CellRow[]> {
  return sqlExecutor.execute<CellRow>(
    `SELECT route, metric, bucket, SUM(count) AS count
     FROM ${VITALS_DAILY_TABLE}
     WHERE day BETWEEN :from AND :to
     GROUP BY route, metric, bucket`,
    { from: range.from, to: range.to }
  );
}

export async function fetchHealthCells(range: DayRange): Promise<CellRow[]> {
  return sqlExecutor.execute<CellRow>(
    `SELECT counter, dim, SUM(count) AS count
     FROM ${HEALTH_DAILY_TABLE}
     WHERE day BETWEEN :from AND :to
     GROUP BY counter, dim`,
    { from: range.from, to: range.to }
  );
}
