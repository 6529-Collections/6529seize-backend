import {
  aggregateTelemetryEvents,
  AnalyticsKind,
  canonicalProps,
  DAILY_HOUR
} from '@/api/telemetry/telemetry-aggregation';
import { sanitizeTelemetryBatch } from '@/api/telemetry/telemetry-sanitizer';

const pv = {
  v: 1,
  t: 'pv',
  route: '/waves/[wave]',
  page_group: 'waves',
  prev_route: 'entry',
  referrer_domain: 'example.com',
  device: 'desktop',
  platform: 'web',
  browser: 'chrome',
  signed_in: true,
  fp: 'fingerprintValue01'
};

describe('aggregateTelemetryEvents', () => {
  it('writes one row per cube and merges repeats', () => {
    const events = sanitizeTelemetryBatch({ v: 1, events: [pv, pv] });
    const { analytics } = aggregateTelemetryEvents(events, {
      country: 'FR',
      hour: 13
    });
    expect(analytics.map((row) => row.kind).sort()).toEqual(
      [
        AnalyticsKind.PV_CLIENT,
        AnalyticsKind.PV_COUNTRY,
        AnalyticsKind.PV_ENTRY,
        AnalyticsKind.PV_FLOW,
        AnalyticsKind.PV_ROUTE
      ].sort()
    );
    expect(analytics.every((row) => row.count === 2)).toBe(true);
    expect(analytics.every((row) => row.hour === DAILY_HOUR)).toBe(true);
    const country = analytics.find(
      (row) => row.kind === AnalyticsKind.PV_COUNTRY
    );
    expect(country?.dims.country).toBe('FR');
    expect(country?.dims.route).toBe('');
  });

  it('never carries fp into any row', () => {
    const increments = aggregateTelemetryEvents(
      sanitizeTelemetryBatch({ v: 1, events: [pv] }),
      { country: '', hour: 1 }
    );
    expect(JSON.stringify(increments)).not.toContain('fingerprintValue01');
    expect(
      increments.analytics.some((row) => row.kind === AnalyticsKind.PV_COUNTRY)
    ).toBe(false);
  });

  it('records product events per hour with canonical props', () => {
    const increments = aggregateTelemetryEvents(
      sanitizeTelemetryBatch({
        v: 1,
        events: [
          {
            v: 1,
            t: 'ev',
            route: '/waves/[wave]',
            device: 'mobile',
            platform: 'android',
            name: 'Wave Feed Load Failed',
            p: { status_bucket: '5xx', product_failure: true }
          }
        ]
      }),
      { country: '', hour: 7 }
    );
    expect(increments.analytics).toEqual([
      expect.objectContaining({
        kind: AnalyticsKind.EV,
        hour: 7,
        count: 1,
        dims: expect.objectContaining({
          name: 'Wave Feed Load Failed',
          props: 'product_failure=true&status_bucket=5xx'
        })
      })
    ]);
    expect(canonicalProps({ b: '2', a: '1' })).toBe('a=1&b=2');
  });

  it('turns vitals and health into histogram and counter rows', () => {
    const increments = aggregateTelemetryEvents(
      sanitizeTelemetryBatch({
        v: 1,
        events: [
          {
            v: 1,
            t: 'vitals',
            route: '/',
            device: 'desktop',
            platform: 'web',
            lcp: 2500,
            cls: 0.05
          },
          {
            v: 1,
            t: 'health',
            route: '/',
            device: 'desktop',
            platform: 'web',
            c: { long_task: 3 },
            ws_lag: 80
          }
        ]
      }),
      { country: '', hour: 0 }
    );
    expect(increments.vitals.map((row) => row.metric).sort()).toEqual(
      ['cls', 'lcp', 'ws_lag'].sort()
    );
    expect(increments.health).toEqual([
      { route: '/', platform: 'web', counter: 'long_task', dim: '', count: 3 }
    ]);
  });
});
