import {
  TELEMETRY_BROWSERS,
  TELEMETRY_DEVICES,
  TELEMETRY_ENTRY_ROUTE,
  TELEMETRY_FP_PATTERN,
  TELEMETRY_HEALTH_ENDPOINT_COUNTERS,
  TELEMETRY_HEALTH_ENUM_COUNTERS,
  TELEMETRY_HEALTH_SCALAR_COUNTERS,
  TELEMETRY_MAX_CLS,
  TELEMETRY_MAX_COUNT,
  TELEMETRY_MAX_DIMS_PER_COUNTER,
  TELEMETRY_MAX_EVENTS_PER_BATCH,
  TELEMETRY_MAX_PRODUCT_EVENT_PROPS,
  TELEMETRY_MAX_VITAL_MS,
  TELEMETRY_OTHER_PAGE_GROUP,
  TELEMETRY_PLATFORMS,
  TELEMETRY_PRODUCT_EVENTS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_TIME_VITALS,
  TelemetryBrowser,
  TelemetryDevice,
  TelemetryPlatform,
  TelemetryPropSpec,
  TelemetryVitalMetric
} from '@/api/telemetry/telemetry.schema';
import {
  sanitizeEndpointTemplate,
  sanitizePageGroup,
  sanitizePageRoute,
  sanitizePrevRoute,
  sanitizeReferrerDomain
} from '@/api/telemetry/telemetry-routes';

export interface TelemetryEventBase {
  readonly route: string;
  readonly device: TelemetryDevice;
  readonly platform: TelemetryPlatform;
}

export interface TelemetryPageView extends TelemetryEventBase {
  readonly t: 'pv';
  readonly pageGroup: string;
  readonly prevRoute: string;
  readonly referrerDomain: string;
  readonly browser: TelemetryBrowser;
  readonly signedIn: boolean | null;
  /** In-memory only; see TELEMETRY_FP_PATTERN. Never stored or logged. */
  readonly fp: string | null;
}

export interface TelemetryVitals extends TelemetryEventBase {
  readonly t: 'vitals';
  readonly metrics: ReadonlyArray<{
    readonly metric: TelemetryVitalMetric;
    readonly value: number;
  }>;
}

export interface TelemetryProductEvent extends TelemetryEventBase {
  readonly t: 'ev';
  readonly name: string;
  readonly props: Readonly<Record<string, string>>;
}

export interface TelemetryHealthCounter {
  readonly counter: string;
  readonly dim: string;
  readonly count: number;
}

export interface TelemetryHealth extends TelemetryEventBase {
  readonly t: 'health';
  readonly counters: readonly TelemetryHealthCounter[];
  readonly wsLag: number | null;
}

export type TelemetryEvent =
  | TelemetryPageView
  | TelemetryVitals
  | TelemetryProductEvent
  | TelemetryHealth;

type UnknownRecord = Readonly<Record<string, unknown>>;

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown
): T | null {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function boundedNumber(value: unknown, max: number): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

function boundedCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= TELEMETRY_MAX_COUNT
    ? value
    : null;
}

function sanitizeBase(raw: UnknownRecord): TelemetryEventBase | null {
  const route = sanitizePageRoute(raw.route);
  const device = oneOf(TELEMETRY_DEVICES, raw.device);
  const platform = oneOf(TELEMETRY_PLATFORMS, raw.platform);
  if (route === null || device === null || platform === null) {
    return null;
  }
  return { route, device, platform };
}

function sanitizePageView(
  raw: UnknownRecord,
  base: TelemetryEventBase
): TelemetryPageView {
  const prevRoute = sanitizePrevRoute(raw.prev_route) ?? TELEMETRY_ENTRY_ROUTE;
  return {
    ...base,
    t: 'pv',
    pageGroup: sanitizePageGroup(raw.page_group) ?? TELEMETRY_OTHER_PAGE_GROUP,
    prevRoute,
    referrerDomain:
      prevRoute === TELEMETRY_ENTRY_ROUTE
        ? sanitizeReferrerDomain(raw.referrer_domain)
        : '',
    browser: oneOf(TELEMETRY_BROWSERS, raw.browser) ?? 'other',
    signedIn: typeof raw.signed_in === 'boolean' ? raw.signed_in : null,
    fp:
      typeof raw.fp === 'string' && TELEMETRY_FP_PATTERN.test(raw.fp)
        ? raw.fp
        : null
  };
}

function sanitizeVitals(
  raw: UnknownRecord,
  base: TelemetryEventBase
): TelemetryVitals | null {
  const metrics: { metric: TelemetryVitalMetric; value: number }[] = [];
  for (const metric of TELEMETRY_TIME_VITALS) {
    const value = boundedNumber(raw[metric], TELEMETRY_MAX_VITAL_MS);
    if (value !== null) {
      metrics.push({ metric, value });
    }
  }
  const cls = boundedNumber(raw.cls, TELEMETRY_MAX_CLS);
  if (cls !== null) {
    metrics.push({ metric: 'cls', value: cls });
  }
  return metrics.length > 0 ? { ...base, t: 'vitals', metrics } : null;
}

function sanitizePropValue(
  spec: TelemetryPropSpec,
  value: unknown
): string | null {
  if (spec === true) {
    return typeof value === 'boolean' ? String(value) : null;
  }
  return oneOf(spec, value);
}

function sanitizeProductEvent(
  raw: UnknownRecord,
  base: TelemetryEventBase
): TelemetryProductEvent | null {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const spec = hasOwn(TELEMETRY_PRODUCT_EVENTS, name)
    ? TELEMETRY_PRODUCT_EVENTS[name]
    : undefined;
  if (!spec) {
    return null;
  }
  const rawProps = isRecord(raw.p) ? raw.p : {};
  const props: Record<string, string> = {};
  for (const [prop, propSpec] of Object.entries(spec)) {
    const value = hasOwn(rawProps, prop)
      ? sanitizePropValue(propSpec, rawProps[prop])
      : null;
    if (value !== null) {
      props[prop] = value;
    }
    if (Object.keys(props).length >= TELEMETRY_MAX_PRODUCT_EVENT_PROPS) {
      break;
    }
  }
  return { ...base, t: 'ev', name, props };
}

function sanitizeDimCounter(
  counter: string,
  raw: unknown,
  sanitizeDim: (dim: string) => string | null
): TelemetryHealthCounter[] {
  if (!isRecord(raw)) {
    return [];
  }
  const totals = new Map<string, number>();
  const entries = Object.entries(raw).slice(0, TELEMETRY_MAX_DIMS_PER_COUNTER);
  for (const [rawDim, rawCount] of entries) {
    const dim = sanitizeDim(rawDim);
    const count = boundedCount(rawCount);
    if (dim !== null && count !== null) {
      totals.set(
        dim,
        Math.min(TELEMETRY_MAX_COUNT, (totals.get(dim) ?? 0) + count)
      );
    }
  }
  return Array.from(totals.entries()).map(([dim, count]) => ({
    counter,
    dim,
    count
  }));
}

function sanitizeHealthCounters(raw: unknown): TelemetryHealthCounter[] {
  if (!isRecord(raw)) {
    return [];
  }
  const counters: TelemetryHealthCounter[] = [];
  for (const counter of TELEMETRY_HEALTH_SCALAR_COUNTERS) {
    const count = boundedCount(raw[counter]);
    if (count !== null) {
      counters.push({ counter, dim: '', count });
    }
  }
  for (const [counter, dims] of Object.entries(
    TELEMETRY_HEALTH_ENUM_COUNTERS
  )) {
    counters.push(
      ...sanitizeDimCounter(counter, raw[counter], (dim) => oneOf(dims, dim))
    );
  }
  for (const counter of TELEMETRY_HEALTH_ENDPOINT_COUNTERS) {
    counters.push(
      ...sanitizeDimCounter(counter, raw[counter], sanitizeEndpointTemplate)
    );
  }
  return counters;
}

function sanitizeHealth(
  raw: UnknownRecord,
  base: TelemetryEventBase
): TelemetryHealth | null {
  const counters = sanitizeHealthCounters(raw.c);
  const wsLag = boundedNumber(raw.ws_lag, TELEMETRY_MAX_VITAL_MS);
  if (counters.length === 0 && wsLag === null) {
    return null;
  }
  return { ...base, t: 'health', counters, wsLag };
}

/**
 * Keeps only what schema v1 allows. Unknown fields are never copied, unknown
 * event types and product events are dropped, and values outside their enum
 * or range are dropped or folded into `/[other]`.
 */
export function sanitizeTelemetryEvent(raw: unknown): TelemetryEvent | null {
  if (!isRecord(raw) || raw.v !== TELEMETRY_SCHEMA_VERSION) {
    return null;
  }
  const base = sanitizeBase(raw);
  if (base === null) {
    return null;
  }
  switch (raw.t) {
    case 'pv':
      return sanitizePageView(raw, base);
    case 'vitals':
      return sanitizeVitals(raw, base);
    case 'ev':
      return sanitizeProductEvent(raw, base);
    case 'health':
      return sanitizeHealth(raw, base);
    default:
      return null;
  }
}

export function sanitizeTelemetryBatch(raw: unknown): TelemetryEvent[] {
  if (
    !isRecord(raw) ||
    raw.v !== TELEMETRY_SCHEMA_VERSION ||
    !Array.isArray(raw.events)
  ) {
    return [];
  }
  const events: TelemetryEvent[] = [];
  for (const rawEvent of raw.events.slice(0, TELEMETRY_MAX_EVENTS_PER_BATCH)) {
    const event = sanitizeTelemetryEvent(rawEvent);
    if (event) {
      events.push(event);
    }
  }
  return events;
}
