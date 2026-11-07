import 'reflect-metadata';
import {
  ANALYTICS_DAILY_TABLE,
  HEALTH_DAILY_TABLE,
  VITALS_DAILY_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aggregateTelemetryEvents } from '@/api/telemetry/telemetry-aggregation';
import { sanitizeTelemetryBatch } from '@/api/telemetry/telemetry-sanitizer';
import {
  deleteTelemetryRowsBefore,
  writeTelemetryIncrements
} from '@/api/telemetry/telemetry.db';

const batch = {
  v: 1,
  events: [
    {
      v: 1,
      t: 'pv',
      route: '/waves/[wave]',
      page_group: 'waves',
      prev_route: 'entry',
      referrer_domain: 'example.com',
      device: 'desktop',
      platform: 'web',
      browser: 'chrome',
      signed_in: true
    },
    {
      v: 1,
      t: 'vitals',
      route: '/waves/[wave]',
      device: 'desktop',
      platform: 'web',
      lcp: 2100
    },
    {
      v: 1,
      t: 'health',
      route: '/waves/[wave]',
      device: 'desktop',
      platform: 'web',
      c: { api_fail: { '/drops/[id]': 2 } }
    },
    {
      v: 1,
      t: 'ev',
      route: '/',
      device: 'desktop',
      platform: 'web',
      name: 'Homepage section seen',
      p: { section: 'Latest drop' }
    }
  ]
};

function increments() {
  return aggregateTelemetryEvents(sanitizeTelemetryBatch(batch), {
    country: 'CA',
    hour: 9
  });
}

async function total(table: string, day: string): Promise<number> {
  const rows = await sqlExecutor.execute<{ total: string | number }>(
    `SELECT COALESCE(SUM(count), 0) AS total FROM ${table} WHERE day = :day`,
    { day }
  );
  return Number(rows[0]?.total ?? 0);
}

describeWithSeed('telemetry daily counters', [], () => {
  it('adds to existing counters instead of replacing them', async () => {
    await writeTelemetryIncrements('2026-11-06', increments());
    await writeTelemetryIncrements('2026-11-06', increments());

    const routeRows = await sqlExecutor.execute<{ count: string | number }>(
      `SELECT count FROM ${ANALYTICS_DAILY_TABLE}
       WHERE day = '2026-11-06' AND kind = 'pv_route'`
    );
    expect(routeRows.map((row) => Number(row.count))).toEqual([2]);
    const eventRows = await sqlExecutor.execute<{
      hour: number;
      props: string;
    }>(
      `SELECT hour, props FROM ${ANALYTICS_DAILY_TABLE}
       WHERE day = '2026-11-06' AND kind = 'ev'`
    );
    expect(eventRows).toEqual([{ hour: 9, props: 'section=Latest drop' }]);
    expect(await total(VITALS_DAILY_TABLE, '2026-11-06')).toBe(2);
    expect(await total(HEALTH_DAILY_TABLE, '2026-11-06')).toBe(4);
  });

  it('deletes only rows older than the retention cutoff', async () => {
    await writeTelemetryIncrements('2024-01-01', increments());
    await writeTelemetryIncrements('2026-11-06', increments());

    const removed = await deleteTelemetryRowsBefore('2024-10-06');

    expect(removed).toBeGreaterThan(0);
    expect(await total(ANALYTICS_DAILY_TABLE, '2024-01-01')).toBe(0);
    expect(await total(VITALS_DAILY_TABLE, '2024-01-01')).toBe(0);
    expect(await total(HEALTH_DAILY_TABLE, '2024-01-01')).toBe(0);
    expect(await total(ANALYTICS_DAILY_TABLE, '2026-11-06')).toBeGreaterThan(0);
  });
});
