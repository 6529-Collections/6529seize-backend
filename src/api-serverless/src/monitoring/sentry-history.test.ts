import { redisCachedWithRefreshLease } from '@/redis';
import { getSentryHistory } from './sentry-history';
import { countSentryWindow, SentryRateLimitError } from './sentry-overview';

jest.mock('@/redis', () => ({ redisCachedWithRefreshLease: jest.fn() }));
jest.mock('./sentry-overview', () => ({
  ...jest.requireActual('./sentry-overview'),
  countSentryWindow: jest.fn()
}));

const keys = [
  'MONITORING_SENTRY_TOKEN',
  'MONITORING_SENTRY_ORG',
  'MONITORING_SENTRY_PROJECTS',
  'MONITORING_SENTRY_ENVIRONMENT',
  'MONITORING_SENTRY_ENVIRONMENT_FILTERS'
] as const;
const previous = keys.map((key) => process.env[key]);

describe('Sentry daily history', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: new Date('2026-10-08T12:30:00Z') });
    process.env.MONITORING_SENTRY_TOKEN = 'private-test-token';
    process.env.MONITORING_SENTRY_ORG = 'team';
    process.env.MONITORING_SENTRY_PROJECTS = 'web;api';
    process.env.MONITORING_SENTRY_ENVIRONMENT = 'production';
    process.env.MONITORING_SENTRY_ENVIRONMENT_FILTERS = 'production;*_prod';
    jest
      .mocked(redisCachedWithRefreshLease)
      .mockImplementation(async (_key, _ttl, callback) => await callback());
    jest
      .mocked(countSentryWindow)
      .mockResolvedValue({ events: 305, issues: 17 });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() =>
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    })
  );

  it('collects 30 completed UTC days per explicit project, without current-status filtering', async () => {
    const result = await getSentryHistory();
    expect(result).toMatchObject({
      status: 'ready',
      period: '30d',
      timezone: 'UTC',
      window_start: new Date('2026-09-08T00:00:00Z'),
      window_end: new Date('2026-10-08T00:00:00Z')
    });
    expect(result.projects.map((p) => p.project)).toEqual(['api', 'web']);
    for (const project of result.projects) {
      expect(project.days).toHaveLength(30);
      expect(project.days[0]).toEqual({
        date: '2026-09-08',
        events: 305,
        issues: 17
      });
      expect(project.days[29]).toEqual({
        date: '2026-10-07',
        events: 305,
        issues: 17
      });
    }
    expect(countSentryWindow).toHaveBeenCalledTimes(60);
    for (const [config, project, start, end, signal] of jest.mocked(
      countSentryWindow
    ).mock.calls) {
      expect(config.environmentFilters).toEqual(['*_prod', 'production']);
      expect(['api', 'web']).toContain(project);
      expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000);
      expect(start).toContain('T00:00:00.000Z');
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(result)).not.toContain('private');
    const [cacheKey, ttl] = jest.mocked(redisCachedWithRefreshLease).mock
      .calls[0];
    expect(cacheKey).toMatch(
      /^monitoring:sentry:history:v1:[a-f0-9]{64}:2026-10-08$/
    );
    expect(ttl.toSeconds()).toBe(900);
  });

  it('preserves successful zeros and marks failed/incomplete days as missing', async () => {
    jest
      .mocked(countSentryWindow)
      .mockImplementation(async (_config, project, start) => {
        if (project === 'api') return { events: 0, issues: 0 };
        if (start.startsWith('2026-10-07'))
          throw new Error('private provider error');
        if (start.startsWith('2026-10-06')) return null;
        return { events: 12, issues: 1 };
      });
    const result = await getSentryHistory();
    expect(result.projects[0].days[29]).toEqual({
      date: '2026-10-07',
      events: 0,
      issues: 0
    });
    expect(result.projects[1].days[29].events).toBeNull();
    expect(result.projects[1].days[28].issues).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private provider error');
  });

  it('bounds concurrent provider collection to four requests', async () => {
    let active = 0;
    let maximum = 0;
    jest.mocked(countSentryWindow).mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return { events: 1, issues: 1 };
    });
    await getSentryHistory();
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });

  it('stops scheduling on a Sentry rate limit and does not cache a false empty chart', async () => {
    jest
      .mocked(countSentryWindow)
      .mockRejectedValue(new SentryRateLimitError());
    await expect(getSentryHistory()).rejects.toThrow(
      'Sentry history collection unavailable'
    );
    expect(countSentryWindow).toHaveBeenCalledTimes(4);
  });

  it('aborts collection at its deadline and leaves unfinished days missing', async () => {
    jest
      .mocked(countSentryWindow)
      .mockResolvedValueOnce({ events: 10, issues: 1 })
      .mockImplementation(
        (_config, _project, _start, _end, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve(null), {
              once: true
            });
          })
      );
    const task = getSentryHistory();
    await jest.advanceTimersByTimeAsync(18_000);
    const result = await task;
    expect(
      result.projects
        .flatMap((p) => p.days)
        .filter((day) => day.events !== null)
    ).toHaveLength(1);
    expect(countSentryWindow).toHaveBeenCalledTimes(5);
  });

  it('shares collection in process and respects the cross-process refresh lease', async () => {
    const [first, second] = await Promise.all([
      getSentryHistory(),
      getSentryHistory()
    ]);
    expect(first).toBe(second);
    expect(redisCachedWithRefreshLease).toHaveBeenCalledTimes(1);
    jest.mocked(redisCachedWithRefreshLease).mockResolvedValueOnce(undefined);
    await expect(getSentryHistory()).rejects.toThrow(
      'Sentry history refresh pending'
    );
    expect(countSentryWindow).toHaveBeenCalledTimes(60);
  });

  it('changes the cache key at UTC midnight and on configuration changes', async () => {
    await getSentryHistory();
    jest.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    await getSentryHistory();
    process.env.MONITORING_SENTRY_TOKEN = 'different-private-token';
    await getSentryHistory();
    const cacheKeys = jest
      .mocked(redisCachedWithRefreshLease)
      .mock.calls.map(([key]) => key);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(cacheKeys[1]).not.toBe(cacheKeys[2]);
    expect(cacheKeys[1]).toMatch(/:2026-10-09$/);
  });

  it('does not query Sentry when credentials are absent', async () => {
    delete process.env.MONITORING_SENTRY_TOKEN;
    expect(await getSentryHistory()).toMatchObject({
      status: 'not_configured',
      projects: []
    });
    expect(countSentryWindow).not.toHaveBeenCalled();
    expect(redisCachedWithRefreshLease).not.toHaveBeenCalled();
  });
});
