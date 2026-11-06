import {
  handleGetTelemetryDashboard,
  handleGetTelemetryPublicStats,
  resolveDashboardRange
} from '@/api/telemetry/telemetry-dashboard.handlers';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { vitalsBucket } from '@/api/telemetry/telemetry-vitals-buckets';

const mockFetchAnalyticsCells = jest.fn();
const mockFetchUniquesDaily = jest.fn();
const mockFetchVitalsBuckets = jest.fn();
const mockFetchHealthCells = jest.fn();

jest.mock('@/api/telemetry/telemetry-dashboard.db', () => ({
  fetchAnalyticsCells: (...args: unknown[]) => mockFetchAnalyticsCells(...args),
  fetchUniquesDaily: (...args: unknown[]) => mockFetchUniquesDaily(...args),
  fetchVitalsBuckets: (...args: unknown[]) => mockFetchVitalsBuckets(...args),
  fetchHealthCells: (...args: unknown[]) => mockFetchHealthCells(...args)
}));

const TEAM_WALLET = '0x00000000000000000000000000000000000000aa';

/** Every cube returns a mix of large and small cells, with every dimension. */
function cellsFor(dimensions: string[]) {
  const row = (count: number, suffix: string) =>
    Object.fromEntries([
      ...dimensions.map((dimension) => [
        dimension,
        dimension === 'day' ? '2026-11-01' : `${dimension}-${suffix}`
      ]),
      ['count', count]
    ]);
  return [
    row(50, 'big'),
    row(4, 'small'),
    row(1, 'tiny'),
    { ...row(3, 'personal'), referrer_domain: 'my-personal-blog.example' }
  ];
}

function allCounts(value: unknown, path = ''): { path: string; n: number }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => allCounts(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      const childPath = `${path}.${key}`;
      if (
        typeof child === 'number' &&
        !['suppression_threshold', 'p50', 'p75', 'p95', 'value'].includes(key)
      ) {
        return [{ path: childPath, n: child }];
      }
      return allCounts(child, childPath);
    });
  }
  return [];
}

describe('telemetry dashboards', () => {
  beforeEach(() => {
    process.env.TELEMETRY_TEAM_WALLETS = TEAM_WALLET;
    mockFetchAnalyticsCells.mockImplementation(
      async (_kind: string, _range: unknown, dimensions: string[]) =>
        cellsFor(dimensions)
    );
    mockFetchUniquesDaily.mockResolvedValue([
      { day: '2026-11-01', metric: 'anonymous_visitors', count: 3 },
      { day: '2026-11-02', metric: 'anonymous_visitors', count: 30 }
    ]);
    mockFetchVitalsBuckets.mockResolvedValue([
      { route: '/', metric: 'lcp', bucket: vitalsBucket(2000), count: 2 },
      { route: '/waves', metric: 'lcp', bucket: vitalsBucket(3000), count: 2 }
    ]);
    mockFetchHealthCells.mockResolvedValue(cellsFor(['counter', 'dim']));
  });

  afterAll(() => {
    delete process.env.TELEMETRY_TEAM_WALLETS;
  });

  it('public output never contains a cell under 5 or a small referrer', async () => {
    const stats = await handleGetTelemetryPublicStats({
      query: { days: '7', period: 'week' }
    } as any);

    const counts = allCounts(stats);
    expect(counts.length).toBeGreaterThan(0);
    for (const { path, n } of counts) {
      expect({ path, n }).toEqual({ path, n: expect.any(Number) });
      expect(n).toBeGreaterThanOrEqual(5);
    }
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain('my-personal-blog.example');
    expect(serialized).not.toContain('-small');
    expect(serialized).not.toContain('-tiny');
    // Too few vitals samples overall (4): withheld.
    expect(stats.vitals).toEqual([]);
    expect(stats.referrers).toEqual([
      { dims: { referrer_domain: 'referrer_domain-big' }, count: 50 }
    ]);
    // Public data carries no product events, flows or health counters.
    expect(Object.keys(stats).sort()).toEqual(
      [
        'browsers',
        'countries',
        'daily',
        'devices',
        'generated_at',
        'period',
        'platforms',
        'referrers',
        'suppression_threshold',
        'top_routes',
        'vitals'
      ].sort()
    );
  });

  it('public breakdowns only cover complete past periods', async () => {
    await expect(
      handleGetTelemetryPublicStats({
        query: { period: 'week', start: '2099-01-05' }
      } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
    const stats = await handleGetTelemetryPublicStats({ query: {} } as any);
    const today = new Date().toISOString().slice(0, 10);
    expect(stats.period.end_day < today).toBe(true);
    expect(stats.daily.every((day) => day.day < today)).toBe(true);
  });

  it('the internal dashboard is team-only and also suppresses small cells', async () => {
    await expect(
      handleGetTelemetryDashboard({
        query: {},
        user: { wallet: '0x00000000000000000000000000000000000000bb' }
      } as any)
    ).rejects.toBeInstanceOf(ForbiddenException);

    const dashboard = await handleGetTelemetryDashboard({
      query: {},
      user: { wallet: TEAM_WALLET },
      res: { setHeader: jest.fn() }
    } as any);
    for (const { n } of allCounts(dashboard)) {
      expect(n).toBeGreaterThanOrEqual(5);
    }
    expect(JSON.stringify(dashboard)).not.toContain('my-personal-blog.example');
  });

  it('validates dashboard ranges', () => {
    expect(resolveDashboardRange({}, '2026-11-06')).toEqual({
      from: '2026-10-08',
      to: '2026-11-06'
    });
    expect(() =>
      resolveDashboardRange(
        { from: '2026-01-01', to: '2026-11-06' },
        '2026-11-06'
      )
    ).toThrow(BadRequestException);
    expect(() =>
      resolveDashboardRange({ to: '2026-11-07' }, '2026-11-06')
    ).toThrow(BadRequestException);
    expect(() =>
      resolveDashboardRange({ from: '2026-02-30' }, '2026-11-06')
    ).toThrow(BadRequestException);
  });
});
