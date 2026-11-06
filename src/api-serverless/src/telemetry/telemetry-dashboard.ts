import { TelemetryVitalMetric } from '@/api/telemetry/telemetry.schema';
import { vitalsQuantile } from '@/api/telemetry/telemetry-vitals-buckets';
import { CellRow } from '@/api/telemetry/telemetry-dashboard.db';

/**
 * Small-cell rule (C52 D3): any published count below 5 is withheld, in the
 * internal dashboard, exports and the public stats page alike. Cells are
 * aggregated first and suppressed last, so a hidden value never leaks
 * through a total that is shown next to it at the same grain.
 */
export const SMALL_CELL_THRESHOLD = 5;

export interface TelemetryCell {
  readonly dims: Record<string, string>;
  readonly count: number;
}

export interface TelemetryRatio {
  readonly name: string;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly value: number | null;
}

export interface TelemetryVitalsSummary {
  readonly route: string;
  readonly metric: string;
  readonly samples: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
}

export const DAILY_TOTAL_METRICS = [
  'page_views',
  'entries',
  'anonymous_visitors',
  'signed_in_dau',
  'signed_in_wau',
  'signed_in_mau',
  'active_profiles_dau',
  'active_profiles_wau',
  'active_profiles_mau'
] as const;
export type DailyTotalMetric = (typeof DAILY_TOTAL_METRICS)[number];
export type TelemetryDailyTotals = { readonly day: string } & Record<
  DailyTotalMetric,
  number | null
>;

export function suppressCount(count: number): number | null {
  return count >= SMALL_CELL_THRESHOLD ? count : null;
}

function compareCells(a: TelemetryCell, b: TelemetryCell): number {
  if (b.count !== a.count) {
    return b.count - a.count;
  }
  return JSON.stringify(a.dims).localeCompare(JSON.stringify(b.dims));
}

/**
 * Sums rows by the given dimensions, drops every cell under the threshold,
 * and returns the largest first.
 */
export function toSuppressedCells(
  rows: readonly CellRow[],
  dimensions: readonly string[],
  limit = 100
): TelemetryCell[] {
  const totals = new Map<string, TelemetryCell>();
  for (const row of rows) {
    const dims: Record<string, string> = {};
    for (const dimension of dimensions) {
      dims[dimension] = String(row[dimension] ?? '');
    }
    const key = JSON.stringify(dims);
    const count = Number(row.count ?? 0) + (totals.get(key)?.count ?? 0);
    totals.set(key, { dims, count });
  }
  return Array.from(totals.values())
    .filter((cell) => cell.count >= SMALL_CELL_THRESHOLD)
    .sort(compareCells)
    .slice(0, limit);
}

/** `a=1&b=2` back into a map (values never contain `&` or `=`). */
export function parseProps(props: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of props ? props.split('&') : []) {
    const separator = pair.indexOf('=');
    if (separator > 0) {
      result[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return result;
}

/** Product-event rows (name, props, count) projected onto chosen props. */
export function productEventCells(
  rows: readonly CellRow[],
  names: readonly string[],
  propKeys: readonly string[],
  limit = 100
): TelemetryCell[] {
  const projected: CellRow[] = [];
  for (const row of rows) {
    const name = String(row.name ?? '');
    if (!names.includes(name)) {
      continue;
    }
    const props = parseProps(String(row.props ?? ''));
    const projectedRow: CellRow = { name, count: Number(row.count ?? 0) };
    for (const key of propKeys) {
      projectedRow[key] = props[key] ?? '';
    }
    projected.push(projectedRow);
  }
  return toSuppressedCells(projected, ['name', ...propKeys], limit);
}

function sumEvents(
  rows: readonly CellRow[],
  name: string,
  prop?: { key: string; value: string }
): number {
  return rows
    .filter((row) => row.name === name)
    .filter(
      (row) =>
        !prop || parseProps(String(row.props ?? ''))[prop.key] === prop.value
    )
    .reduce((sum, row) => sum + Number(row.count ?? 0), 0);
}

function ratio(
  name: string,
  numerator: number,
  denominator: number
): TelemetryRatio {
  const shownNumerator = suppressCount(numerator);
  const shownDenominator = suppressCount(denominator);
  return {
    name,
    numerator: shownNumerator,
    denominator: shownDenominator,
    value:
      shownNumerator !== null && shownDenominator !== null
        ? numerator / denominator
        : null
  };
}

/** The Product Impact board's ratio formulas, from aggregated counts. */
export function productImpactRatios(
  rows: readonly CellRow[]
): TelemetryRatio[] {
  const started = sumEvents(rows, 'Wave Feed Load Started');
  const refreshed = sumEvents(rows, 'Auth Session Refresh Succeeded');
  const cancelledValidations = sumEvents(rows, 'Auth Validation Cancelled');
  return [
    ratio(
      'waves_succeeded_per_started',
      sumEvents(rows, 'Wave Feed Load Succeeded'),
      started
    ),
    ratio(
      'waves_failed_per_started',
      sumEvents(rows, 'Wave Feed Load Failed'),
      started
    ),
    ratio(
      'waves_cancelled_per_started',
      sumEvents(rows, 'Wave Feed Load Cancelled'),
      started
    ),
    ratio(
      'waves_product_failures_per_started',
      sumEvents(rows, 'Wave Feed Load Failed', {
        key: 'product_failure',
        value: 'true'
      }),
      started
    ),
    ratio(
      'auth_reauth_prompts_per_refresh',
      sumEvents(rows, 'Auth Reauth Prompt Shown'),
      refreshed
    ),
    ratio(
      'auth_forced_logouts_per_refresh',
      sumEvents(rows, 'Auth Forced Logout'),
      refreshed
    ),
    ratio(
      'auth_validation_failures_per_refresh',
      sumEvents(rows, 'Auth Validation Failed While Connected'),
      refreshed
    ),
    ratio(
      'auth_session_upgrade_prompts_per_refresh',
      sumEvents(rows, 'Auth Session Upgrade Prompt Shown'),
      refreshed
    ),
    ratio(
      'auth_recovered_per_refresh',
      sumEvents(rows, 'Auth Session Refresh Recovered'),
      refreshed
    ),
    ratio(
      'auth_cancelled_validations_share',
      cancelledValidations,
      refreshed + cancelledValidations
    )
  ];
}

/**
 * p50/p75/p95 per route and metric, plus an overall row per metric with
 * route `*`. Groups with fewer than five samples are withheld.
 */
export function vitalsSummaries(
  rows: readonly CellRow[],
  options: { readonly perRoute: boolean }
): TelemetryVitalsSummary[] {
  const groups = new Map<
    string,
    {
      route: string;
      metric: string;
      buckets: { bucket: number; count: number }[];
    }
  >();
  const add = (
    route: string,
    metric: string,
    bucket: number,
    count: number
  ) => {
    const key = `${route}|${metric}`;
    const group = groups.get(key) ?? { route, metric, buckets: [] };
    group.buckets.push({ bucket, count });
    groups.set(key, group);
  };
  for (const row of rows) {
    const metric = String(row.metric);
    const bucket = Number(row.bucket);
    const count = Number(row.count ?? 0);
    add('*', metric, bucket, count);
    if (options.perRoute) {
      add(String(row.route), metric, bucket, count);
    }
  }
  const summaries: TelemetryVitalsSummary[] = [];
  for (const { route, metric, buckets } of Array.from(groups.values())) {
    const samples = buckets.reduce((sum, entry) => sum + entry.count, 0);
    if (samples < SMALL_CELL_THRESHOLD) {
      continue;
    }
    const vital = metric as TelemetryVitalMetric;
    summaries.push({
      route,
      metric,
      samples,
      p50: vitalsQuantile(vital, buckets, 0.5) ?? 0,
      p75: vitalsQuantile(vital, buckets, 0.75) ?? 0,
      p95: vitalsQuantile(vital, buckets, 0.95) ?? 0
    });
  }
  return summaries.sort(
    (a, b) =>
      b.samples - a.samples ||
      a.route.localeCompare(b.route) ||
      a.metric.localeCompare(b.metric)
  );
}

function emptyTotals(): Record<string, number> {
  return Object.fromEntries(DAILY_TOTAL_METRICS.map((metric) => [metric, 0]));
}

/**
 * Daily totals from page-view cubes and the uniques table, every value
 * suppressed under the threshold.
 */
export function dailyTotals(
  days: readonly string[],
  pageViewsByDay: readonly CellRow[],
  entriesByDay: readonly CellRow[],
  uniquesByDay: readonly CellRow[]
): TelemetryDailyTotals[] {
  const raw = new Map<string, Record<string, number>>(
    days.map((day) => [day, emptyTotals()])
  );
  const addTo = (day: unknown, metric: string, count: unknown) => {
    const totals = raw.get(String(day));
    if (totals && metric in totals) {
      totals[metric] += Number(count ?? 0);
    }
  };
  for (const row of pageViewsByDay) {
    addTo(row.day, 'page_views', row.count);
  }
  for (const row of entriesByDay) {
    addTo(row.day, 'entries', row.count);
  }
  for (const row of uniquesByDay) {
    addTo(row.day, String(row.metric), row.count);
  }
  return days.map((day) => {
    const totals = raw.get(day)!;
    const result: Record<string, number | null | string> = { day };
    for (const metric of DAILY_TOTAL_METRICS) {
      result[metric] = suppressCount(totals[metric]);
    }
    return result as TelemetryDailyTotals;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00Z`);
    time <= Date.parse(`${to}T00:00:00Z`);
    time += DAY_MS
  ) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function shiftDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * A complete, non-overlapping calendar period (ISO week from Monday, or
 * month) that ended before `today`. Public breakdowns are published only for
 * such periods, so overlapping windows can never be subtracted to reveal a
 * hidden day.
 */
export function completePeriod(
  type: 'week' | 'month',
  today: string,
  start?: string
): { from: string; to: string } | null {
  let from: string;
  let to: string;
  if (type === 'week') {
    const anchor = start ?? shiftDay(today, -7);
    const weekday = (new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (start && weekday !== 0) {
      return null;
    }
    from = shiftDay(anchor, -weekday);
    to = shiftDay(from, 6);
  } else {
    const anchor =
      start ?? `${shiftDay(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
    if (start && !start.endsWith('-01')) {
      return null;
    }
    from = anchor;
    const [year, month] = anchor.split('-').map(Number);
    to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  return to < today ? { from, to } : null;
}
