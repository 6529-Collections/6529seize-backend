import 'reflect-metadata';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aggregateTelemetryEvents,
  AnalyticsKind
} from '@/api/telemetry/telemetry-aggregation';
import { sanitizeTelemetryBatch } from '@/api/telemetry/telemetry-sanitizer';
import { writeTelemetryIncrements } from '@/api/telemetry/telemetry.db';
import {
  fetchAnalyticsCells,
  fetchHealthCells,
  fetchVitalsBuckets
} from '@/api/telemetry/telemetry-dashboard.db';

const pageView = (route: string, referrer: string) => ({
  v: 1,
  t: 'pv',
  route,
  page_group: 'waves',
  prev_route: 'entry',
  referrer_domain: referrer,
  device: 'mobile',
  platform: 'ios',
  browser: 'safari'
});

async function write(day: string, events: unknown[], hour = 10) {
  await writeTelemetryIncrements(
    day,
    aggregateTelemetryEvents(sanitizeTelemetryBatch({ v: 1, events }), {
      country: 'CA',
      hour
    })
  );
}

describeWithSeed('telemetry dashboard queries', [], () => {
  it('sums cubes across the day range and groups by the requested dimensions', async () => {
    await write('2026-11-01', [
      pageView('/waves', 'example.com'),
      pageView('/waves', 'example.com'),
      {
        v: 1,
        t: 'vitals',
        route: '/waves',
        device: 'mobile',
        platform: 'ios',
        lcp: 2000
      },
      {
        v: 1,
        t: 'health',
        route: '/waves',
        device: 'mobile',
        platform: 'ios',
        c: { ws_drop: 3 }
      },
      {
        v: 1,
        t: 'ev',
        route: '/',
        device: 'mobile',
        platform: 'ios',
        name: 'Homepage section seen',
        p: { section: 'Latest drop' }
      }
    ]);
    await write('2026-11-02', [pageView('/waves', 'other.example')], 11);
    await write('2026-10-01', [pageView('/waves', 'example.com')]);

    const range = { from: '2026-11-01', to: '2026-11-02' };
    const routes = await fetchAnalyticsCells(AnalyticsKind.PV_ROUTE, range, [
      'route'
    ]);
    expect(routes.map((r) => [r.route, Number(r.count)])).toEqual([
      ['/waves', 3]
    ]);
    const referrers = await fetchAnalyticsCells(AnalyticsKind.PV_ENTRY, range, [
      'referrer_domain'
    ]);
    expect(
      referrers
        .map((r) => [r.referrer_domain, Number(r.count)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toEqual([
      ['example.com', 2],
      ['other.example', 1]
    ]);
    const byDay = await fetchAnalyticsCells(AnalyticsKind.PV_CLIENT, range, [
      'day'
    ]);
    expect(
      byDay
        .map((r) => [r.day, Number(r.count)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toEqual([
      ['2026-11-01', 2],
      ['2026-11-02', 1]
    ]);
    const events = await fetchAnalyticsCells(AnalyticsKind.EV, range, [
      'day',
      'hour',
      'name'
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        day: '2026-11-01',
        name: 'Homepage section seen'
      })
    ]);
    expect(Number(events[0].hour)).toBe(10);
    expect(
      (await fetchVitalsBuckets(range)).map((r) => Number(r.count))
    ).toEqual([1]);
    expect(
      (await fetchHealthCells(range)).map((r) => [r.counter, Number(r.count)])
    ).toEqual([['ws_drop', 3]]);
  });
});
