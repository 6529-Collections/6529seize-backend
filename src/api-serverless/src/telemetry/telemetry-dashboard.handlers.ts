import * as Joi from 'joi';
import { ApiTelemetryDashboard } from '@/api/generated/models/ApiTelemetryDashboard';
import { ApiTelemetryPeriodTypeEnum } from '@/api/generated/models/ApiTelemetryPeriod';
import { ApiTelemetryPublicStats } from '@/api/generated/models/ApiTelemetryPublicStats';
import {
  GetTelemetryDashboardRequest,
  GetTelemetryPublicStatsRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException } from '@/exceptions';
import { AnalyticsKind } from '@/api/telemetry/telemetry-aggregation';
import { utcDay } from '@/api/telemetry/telemetry-daily-salt';
import { assertTelemetryTeamReader } from '@/api/telemetry/telemetry-team-auth';
import {
  DayRange,
  fetchAnalyticsCells,
  fetchHealthCells,
  fetchUniquesDaily,
  fetchVitalsBuckets
} from '@/api/telemetry/telemetry-dashboard.db';
import {
  completePeriod,
  dailyTotals,
  daysBetween,
  productEventCells,
  productImpactRatios,
  shiftDay,
  SMALL_CELL_THRESHOLD,
  toSuppressedCells,
  vitalsSummaries
} from '@/api/telemetry/telemetry-dashboard';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DASHBOARD_DAYS = 92;
const HOURLY_DAYS = 2;

const HOMEPAGE_SEEN = 'Homepage section seen';
const HOMEPAGE_CLICKED = 'Homepage action clicked';
const PROFILE_SEEN = 'Profile section seen';
const PROFILE_CLICKED = 'Profile action clicked';
const WAVE_FEATURE_EVENTS = ['Wave Feature Seen', 'Wave Feature Activated'];
const PRODUCT_IMPACT_EVENTS = [
  'Auth Forced Logout',
  'Auth Reauth Prompt Shown',
  'Auth Session Refresh Recovered',
  'Auth Session Refresh Succeeded',
  'Auth Session Upgrade Prompt Shown',
  'Auth Validation Cancelled',
  'Auth Validation Failed While Connected',
  'Auth Session Refresh Product Impact',
  'Wave Feed Load Started',
  'Wave Feed Load Succeeded',
  'Wave Feed Load Cancelled',
  'Wave Feed Load Failed'
];

type ResHolder = {
  res?: { setHeader: (name: string, value: string) => unknown };
};

function isValidDay(day: string): boolean {
  return (
    DAY_PATTERN.test(day) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  );
}

const DashboardQuerySchema = Joi.object<{ from?: string; to?: string }>({
  from: Joi.string().pattern(DAY_PATTERN),
  to: Joi.string().pattern(DAY_PATTERN)
}).unknown(false);

const PublicQuerySchema = Joi.object<{
  days: number;
  period: 'week' | 'month';
  start?: string;
}>({
  days: Joi.number().integer().min(1).max(90).default(30),
  period: Joi.string().valid('week', 'month').default('week'),
  start: Joi.string().pattern(DAY_PATTERN)
}).unknown(false);

export function resolveDashboardRange(
  query: { from?: string; to?: string },
  today: string
): DayRange {
  const to = query.to ?? today;
  const from = query.from ?? shiftDay(to, -29);
  if (!isValidDay(from) || !isValidDay(to) || from > to || to > today) {
    throw new BadRequestException(
      'from and to must be valid days, from <= to <= today'
    );
  }
  if (daysBetween(from, to).length > MAX_DASHBOARD_DAYS) {
    throw new BadRequestException(`At most ${MAX_DASHBOARD_DAYS} days`);
  }
  return { from, to };
}

/**
 * Internal dashboard, for the same readers as diagnostics bundles (current
 * writers in the team reader wave). Every cell under 5 is withheld.
 */
export async function handleGetTelemetryDashboard(
  req: GetTelemetryDashboardRequest
): Promise<ApiTelemetryDashboard> {
  await assertTelemetryTeamReader(req);
  (req as ResHolder).res?.setHeader('Cache-Control', 'private, no-store');
  const query = getValidatedByJoiOrThrow(req.query, DashboardQuerySchema);
  const range = resolveDashboardRange(query, utcDay(new Date()));
  const hourlyFrom = shiftDay(range.to, 1 - HOURLY_DAYS);
  const hourlyRange = {
    from: hourlyFrom > range.from ? hourlyFrom : range.from,
    to: range.to
  };
  const [
    routeRows,
    flowRows,
    entryRows,
    clientRows,
    countryRows,
    eventRows,
    hourlyRows,
    viewsByDay,
    entriesByDay,
    uniques,
    vitals,
    health
  ] = await Promise.all([
    fetchAnalyticsCells(AnalyticsKind.PV_ROUTE, range, [
      'route',
      'device',
      'platform',
      'signed_in'
    ]),
    fetchAnalyticsCells(AnalyticsKind.PV_FLOW, range, ['prev_route', 'route']),
    fetchAnalyticsCells(AnalyticsKind.PV_ENTRY, range, ['referrer_domain']),
    fetchAnalyticsCells(AnalyticsKind.PV_CLIENT, range, [
      'device',
      'platform',
      'browser'
    ]),
    fetchAnalyticsCells(AnalyticsKind.PV_COUNTRY, range, ['country']),
    fetchAnalyticsCells(AnalyticsKind.EV, range, ['name', 'props']),
    fetchAnalyticsCells(AnalyticsKind.EV, hourlyRange, ['day', 'hour', 'name']),
    fetchAnalyticsCells(AnalyticsKind.PV_CLIENT, range, ['day']),
    fetchAnalyticsCells(AnalyticsKind.PV_ENTRY, range, ['day']),
    fetchUniquesDaily(range),
    fetchVitalsBuckets(range),
    fetchHealthCells(range)
  ]);
  return {
    start_day: range.from,
    end_day: range.to,
    suppression_threshold: SMALL_CELL_THRESHOLD,
    daily: dailyTotals(
      daysBetween(range.from, range.to),
      viewsByDay,
      entriesByDay,
      uniques
    ),
    top_routes: toSuppressedCells(routeRows, ['route'], 100),
    route_devices: toSuppressedCells(
      routeRows,
      ['route', 'device', 'platform'],
      300
    ),
    route_signed_in: toSuppressedCells(routeRows, ['route', 'signed_in'], 200),
    flows: toSuppressedCells(flowRows, ['prev_route', 'route'], 200),
    referrers: toSuppressedCells(entryRows, ['referrer_domain'], 100),
    clients: toSuppressedCells(
      clientRows,
      ['device', 'platform', 'browser'],
      100
    ),
    countries: toSuppressedCells(countryRows, ['country'], 250),
    vitals: vitalsSummaries(vitals, { perRoute: true }),
    health: toSuppressedCells(health, ['counter', 'dim'], 200),
    product_events: toSuppressedCells(eventRows, ['name', 'props'], 500),
    reports: {
      homepage_sections: productEventCells(
        eventRows,
        [HOMEPAGE_SEEN],
        ['section']
      ),
      homepage_actions: productEventCells(
        eventRows,
        [HOMEPAGE_CLICKED],
        ['section', 'action']
      ),
      homepage_next_pages: toSuppressedCells(
        flowRows.filter((row) => row.prev_route === '/'),
        ['route'],
        50
      ),
      profile_sections: productEventCells(
        eventRows,
        [PROFILE_SEEN],
        ['section']
      ),
      profile_actions: productEventCells(
        eventRows,
        [PROFILE_CLICKED],
        ['section', 'action']
      ),
      product_impact_counts: productEventCells(
        eventRows,
        PRODUCT_IMPACT_EVENTS,
        []
      ),
      product_impact_hourly: toSuppressedCells(
        hourlyRows.filter((row) =>
          PRODUCT_IMPACT_EVENTS.includes(String(row.name))
        ),
        ['day', 'hour', 'name'],
        1000
      ),
      product_impact_ratios: productImpactRatios(eventRows),
      wave_pilot: productEventCells(
        eventRows,
        WAVE_FEATURE_EVENTS,
        ['feature', 'value', 'placement'],
        300
      )
    }
  };
}

/**
 * Public stats page data: daily totals for the last complete days, and
 * breakdowns for one complete calendar week or month. No identifiers, no
 * cell under 5, and no overlapping windows that could be subtracted.
 */
export async function handleGetTelemetryPublicStats(
  req: GetTelemetryPublicStatsRequest
): Promise<ApiTelemetryPublicStats> {
  const query = getValidatedByJoiOrThrow(req.query, PublicQuerySchema);
  const today = utcDay(new Date());
  if (query.start && !isValidDay(query.start)) {
    throw new BadRequestException('start must be a valid day');
  }
  const period = completePeriod(query.period, today, query.start);
  if (!period) {
    throw new BadRequestException(
      'start must begin a complete week (Monday) or month (day 01) in the past'
    );
  }
  const daily: DayRange = {
    from: shiftDay(today, -query.days),
    to: shiftDay(today, -1)
  };
  const [
    viewsByDay,
    entriesByDay,
    uniques,
    routes,
    entries,
    clients,
    countries,
    vitals
  ] = await Promise.all([
    fetchAnalyticsCells(AnalyticsKind.PV_CLIENT, daily, ['day']),
    fetchAnalyticsCells(AnalyticsKind.PV_ENTRY, daily, ['day']),
    fetchUniquesDaily(daily),
    fetchAnalyticsCells(AnalyticsKind.PV_ROUTE, period, ['route']),
    fetchAnalyticsCells(AnalyticsKind.PV_ENTRY, period, ['referrer_domain']),
    fetchAnalyticsCells(AnalyticsKind.PV_CLIENT, period, [
      'device',
      'platform',
      'browser'
    ]),
    fetchAnalyticsCells(AnalyticsKind.PV_COUNTRY, period, ['country']),
    fetchVitalsBuckets(period)
  ]);
  return {
    generated_at: new Date(),
    suppression_threshold: SMALL_CELL_THRESHOLD,
    daily: dailyTotals(
      daysBetween(daily.from, daily.to),
      viewsByDay,
      entriesByDay,
      uniques
    ),
    period: {
      type:
        query.period === 'month'
          ? ApiTelemetryPeriodTypeEnum.Month
          : ApiTelemetryPeriodTypeEnum.Week,
      start_day: period.from,
      end_day: period.to
    },
    top_routes: toSuppressedCells(routes, ['route'], 25),
    referrers: toSuppressedCells(entries, ['referrer_domain'], 25),
    devices: toSuppressedCells(clients, ['device'], 10),
    platforms: toSuppressedCells(clients, ['platform'], 10),
    browsers: toSuppressedCells(clients, ['browser'], 10),
    countries: toSuppressedCells(countries, ['country'], 50),
    vitals: vitalsSummaries(vitals, { perRoute: false })
  };
}
