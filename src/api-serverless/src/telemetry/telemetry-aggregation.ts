import { createHash } from 'node:crypto';
import { TELEMETRY_ENTRY_ROUTE } from '@/api/telemetry/telemetry.schema';
import {
  TelemetryEvent,
  TelemetryHealth,
  TelemetryPageView,
  TelemetryProductEvent,
  TelemetryVitals
} from '@/api/telemetry/telemetry-sanitizer';
import {
  vitalsBucket,
  vitalsUnitValue
} from '@/api/telemetry/telemetry-vitals-buckets';

/**
 * Counter "cubes" written to analytics_daily. Each page view increments one
 * row per cube, so every report reads a small, independent set of
 * dimensions instead of one wide combination (which would also make far more
 * cells fall under the small-cell threshold).
 */
export enum AnalyticsKind {
  /** route x page group x device x platform x signed-in */
  PV_ROUTE = 'pv_route',
  /** previous route -> route (the "next page" report; `entry` = arrival) */
  PV_FLOW = 'pv_flow',
  /** arrivals by referrer domain ('' = direct or unknown) */
  PV_ENTRY = 'pv_entry',
  /** device x platform x browser family */
  PV_CLIENT = 'pv_client',
  /** viewer country from the CDN edge, when known */
  PV_COUNTRY = 'pv_country',
  /** product events, per UTC hour */
  EV = 'ev'
}

/** `hour` value for rows that are daily totals. */
export const DAILY_HOUR = -1;
/** signed_in value when the dimension does not apply. */
export const SIGNED_IN_NA = -1;

export interface AnalyticsDims {
  readonly name: string;
  readonly route: string;
  readonly prev_route: string;
  readonly page_group: string;
  readonly referrer_domain: string;
  readonly device: string;
  readonly platform: string;
  readonly browser: string;
  readonly signed_in: number;
  readonly country: string;
  readonly props: string;
}

export interface AnalyticsIncrement {
  readonly hour: number;
  readonly kind: AnalyticsKind;
  readonly dims_key: string;
  readonly dims: AnalyticsDims;
  count: number;
}

export interface VitalsIncrement {
  readonly route: string;
  readonly device: string;
  readonly platform: string;
  readonly metric: string;
  readonly bucket: number;
  count: number;
}

export interface HealthIncrement {
  readonly route: string;
  readonly platform: string;
  readonly counter: string;
  readonly dim: string;
  count: number;
}

export interface TelemetryIncrements {
  readonly analytics: AnalyticsIncrement[];
  readonly vitals: VitalsIncrement[];
  readonly health: HealthIncrement[];
}

export interface TelemetryAggregationContext {
  /** ISO country code from a trusted edge header, or '' when unknown. */
  readonly country: string;
  /** UTC hour of receipt, used only for product-event rows. */
  readonly hour: number;
}

const EMPTY_DIMS: AnalyticsDims = {
  name: '',
  route: '',
  prev_route: '',
  page_group: '',
  referrer_domain: '',
  device: '',
  platform: '',
  browser: '',
  signed_in: SIGNED_IN_NA,
  country: '',
  props: ''
};

export function analyticsDimsKey(
  kind: AnalyticsKind,
  dims: AnalyticsDims
): string {
  const canonical = JSON.stringify([
    kind,
    dims.name,
    dims.route,
    dims.prev_route,
    dims.page_group,
    dims.referrer_domain,
    dims.device,
    dims.platform,
    dims.browser,
    dims.signed_in,
    dims.country,
    dims.props
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Canonical `key=value&key=value` form, sorted by key. */
export function canonicalProps(
  props: Readonly<Record<string, string>>
): string {
  return Object.keys(props)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${props[key]}`)
    .join('&');
}

class IncrementCollector {
  private readonly analytics = new Map<string, AnalyticsIncrement>();
  private readonly vitals = new Map<string, VitalsIncrement>();
  private readonly health = new Map<string, HealthIncrement>();

  addAnalytics(
    kind: AnalyticsKind,
    partial: Partial<AnalyticsDims>,
    hour: number = DAILY_HOUR
  ) {
    const dims: AnalyticsDims = { ...EMPTY_DIMS, ...partial };
    const dimsKey = analyticsDimsKey(kind, dims);
    const key = `${hour}|${dimsKey}`;
    const existing = this.analytics.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.analytics.set(key, {
        hour,
        kind,
        dims_key: dimsKey,
        dims,
        count: 1
      });
    }
  }

  addVitals(increment: Omit<VitalsIncrement, 'count'>) {
    const key = JSON.stringify(increment);
    const existing = this.vitals.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.vitals.set(key, { ...increment, count: 1 });
    }
  }

  addHealth(increment: Omit<HealthIncrement, 'count'>, count: number) {
    const key = JSON.stringify(increment);
    const existing = this.health.get(key);
    if (existing) {
      existing.count += count;
    } else {
      this.health.set(key, { ...increment, count });
    }
  }

  build(): TelemetryIncrements {
    return {
      analytics: Array.from(this.analytics.values()),
      vitals: Array.from(this.vitals.values()),
      health: Array.from(this.health.values())
    };
  }
}

function addPageView(
  collector: IncrementCollector,
  event: TelemetryPageView,
  ctx: TelemetryAggregationContext
) {
  const { route, device, platform } = event;
  let signedIn = SIGNED_IN_NA;
  if (event.signedIn !== null) {
    signedIn = event.signedIn ? 1 : 0;
  }
  collector.addAnalytics(AnalyticsKind.PV_ROUTE, {
    route,
    page_group: event.pageGroup,
    device,
    platform,
    signed_in: signedIn
  });
  collector.addAnalytics(AnalyticsKind.PV_FLOW, {
    prev_route: event.prevRoute,
    route
  });
  if (event.prevRoute === TELEMETRY_ENTRY_ROUTE) {
    collector.addAnalytics(AnalyticsKind.PV_ENTRY, {
      referrer_domain: event.referrerDomain,
      device,
      platform
    });
  }
  collector.addAnalytics(AnalyticsKind.PV_CLIENT, {
    device,
    platform,
    browser: event.browser
  });
  if (ctx.country) {
    collector.addAnalytics(AnalyticsKind.PV_COUNTRY, { country: ctx.country });
  }
}

function addVitals(collector: IncrementCollector, event: TelemetryVitals) {
  for (const { metric, value } of event.metrics) {
    collector.addVitals({
      route: event.route,
      device: event.device,
      platform: event.platform,
      metric,
      bucket: vitalsBucket(vitalsUnitValue(metric, value))
    });
  }
}

function addProductEvent(
  collector: IncrementCollector,
  event: TelemetryProductEvent,
  ctx: TelemetryAggregationContext
) {
  collector.addAnalytics(
    AnalyticsKind.EV,
    {
      name: event.name,
      route: event.route,
      device: event.device,
      platform: event.platform,
      props: canonicalProps(event.props)
    },
    ctx.hour
  );
}

function addHealth(collector: IncrementCollector, event: TelemetryHealth) {
  for (const { counter, dim, count } of event.counters) {
    collector.addHealth(
      { route: event.route, platform: event.platform, counter, dim },
      count
    );
  }
  if (event.wsLag !== null) {
    collector.addVitals({
      route: event.route,
      device: event.device,
      platform: event.platform,
      metric: 'ws_lag',
      bucket: vitalsBucket(vitalsUnitValue('ws_lag', event.wsLag))
    });
  }
}

/** Turns sanitized events into merged counter increments. */
export function aggregateTelemetryEvents(
  events: readonly TelemetryEvent[],
  ctx: TelemetryAggregationContext
): TelemetryIncrements {
  const collector = new IncrementCollector();
  for (const event of events) {
    switch (event.t) {
      case 'pv':
        addPageView(collector, event, ctx);
        break;
      case 'vitals':
        addVitals(collector, event);
        break;
      case 'ev':
        addProductEvent(collector, event, ctx);
        break;
      case 'health':
        addHealth(collector, event);
        break;
    }
  }
  return collector.build();
}
