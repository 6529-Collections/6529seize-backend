import fetch, { Response } from 'node-fetch';
import { redisCached } from '@/redis';
import { Time } from '@/time';
import {
  getSentryOverview,
  getSentryConfig,
  countSentryWindow
} from './sentry-overview';

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/redis', () => ({ redisCached: jest.fn() }));

const configKeys = [
  'MONITORING_SENTRY_TOKEN',
  'MONITORING_SENTRY_ORG',
  'MONITORING_SENTRY_PROJECTS',
  'MONITORING_SENTRY_ENVIRONMENT',
  'MONITORING_SENTRY_ENVIRONMENT_FILTERS'
] as const;
const previous = configKeys.map((key) => process.env[key]);

function issue(id = '123') {
  return {
    id,
    shortId: 'WEB-123',
    title: 'TypeError: failed',
    project: { slug: 'web' },
    level: 'error',
    priority: 'high',
    status: 'unresolved',
    substatus: 'ongoing',
    count: '9999',
    firstSeen: '2020-01-01T00:00:00Z',
    lastSeen: '2026-10-08T00:00:00Z',
    filtered: {
      count: '12',
      firstSeen: '2026-10-07T10:00:00Z',
      lastSeen: '2026-10-08T00:00:00Z'
    },
    permalink: 'https://untrusted.example/',
    metadata: { private: 'must not appear' }
  };
}

function response(
  body: unknown,
  ok = true,
  headers: Record<string, string | undefined> = {}
): Response {
  return {
    ok,
    json: async () => body,
    headers: { get: (name: string) => headers[name] ?? null }
  } as Response;
}

describe('Sentry monitoring collection', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.MONITORING_SENTRY_TOKEN = 'private-test-token';
    process.env.MONITORING_SENTRY_ORG = 'team';
    process.env.MONITORING_SENTRY_PROJECTS = 'web;api';
    process.env.MONITORING_SENTRY_ENVIRONMENT = 'production';
    delete process.env.MONITORING_SENTRY_ENVIRONMENT_FILTERS;
    jest
      .mocked(redisCached)
      .mockImplementation(async (_key, _ttl, callback) => await callback());
    jest.mocked(fetch).mockResolvedValue(response([issue()]));
  });
  afterAll(() =>
    configKeys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    })
  );

  it.each([
    'MONITORING_SENTRY_TOKEN',
    'MONITORING_SENTRY_ORG',
    'MONITORING_SENTRY_PROJECTS'
  ])('does not call the provider when %s is absent', async (key) => {
    delete process.env[key];
    expect((await getSentryOverview()).status).toBe('not_configured');
    expect(fetch).not.toHaveBeenCalled();
    expect(redisCached).not.toHaveBeenCalled();
  });

  it('bounds project, environment, time, sort, size and timeout; returns only window aggregates and safe links', async () => {
    const result = await getSentryOverview();
    expect(fetch).toHaveBeenCalledTimes(14);
    const urls = jest
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)));
    for (const url of urls) {
      expect(url.origin).toBe('https://sentry.io');
      expect(url.pathname).toBe('/api/0/organizations/team/issues/');
      expect(url.searchParams.getAll('project')).toHaveLength(1);
      expect(['api', 'web']).toContain(url.searchParams.get('project'));
      expect(url.searchParams.has('environment')).toBe(false);
      expect(url.searchParams.get('query')).toContain(
        'tags[environment]:[production]'
      );
      expect(['6', '50']).toContain(url.searchParams.get('limit'));
      expect(
        Date.parse(url.searchParams.get('end')!) -
          Date.parse(url.searchParams.get('start')!)
      ).toBe(86_400_000);
    }
    expect(urls[0].searchParams.get('query')).toContain('firstSeen:>=');
    expect(urls[1].searchParams.get('query')).toBe(
      'is:unresolved issue.category:error tags[environment]:[production]'
    );
    expect(urls[1].searchParams.get('sort')).toBe('freq');
    expect(jest.mocked(fetch).mock.calls[0][1]).toMatchObject({
      timeout: 8_000,
      size: 512_000,
      redirect: 'error'
    });
    expect(result.projects[0].top_issues[0]).toEqual({
      id: '123',
      short_id: 'WEB-123',
      title: 'TypeError: failed',
      project: 'web',
      occurrences: 12,
      first_seen: '2026-10-07T10:00:00.000Z',
      last_seen: '2026-10-08T00:00:00.000Z',
      url: 'https://sentry.io/organizations/team/issues/123/',
      level: 'error',
      priority: 'high',
      state: 'ongoing'
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(redisCached).toHaveBeenCalledWith(
      expect.stringMatching(/^monitoring:sentry:v3:[a-f0-9]{64}$/),
      expect.any(Time),
      expect.any(Function)
    );
    expect(jest.mocked(redisCached).mock.calls[0][1].toSeconds()).toBe(300);
  });

  it('counts repeated events separately from distinct daily issues and ignores lifetime totals', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValue(response([issue('123'), issue('456')]));
    const config = getSentryConfig();
    if (!config) throw new Error('Missing fixture configuration');
    expect(
      await countSentryWindow(
        config,
        'web',
        '2026-10-07T00:00:00Z',
        '2026-10-08T00:00:00Z'
      )
    ).toEqual({ events: 24, issues: 2 });
  });

  it('limits lists to five and identifies additional matches without claiming a total', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValue(
        response(Array.from({ length: 6 }, (_, index) => issue(String(index))))
      );
    const result = await getSentryOverview();
    expect(result.projects[0].new_issues).toHaveLength(5);
    expect(result.projects[0].new_issues_has_more).toBe(true);
    expect(result.projects[0].top_issues_has_more).toBe(true);
  });

  it('represents successful empty snapshots separately from missing configuration', async () => {
    jest.mocked(fetch).mockResolvedValue(response([]));
    expect(await getSentryOverview()).toMatchObject({
      status: 'ready',
      projects: [
        expect.objectContaining({
          project: 'api',
          top_issues: [],
          new_issues: []
        }),
        expect.objectContaining({
          project: 'web',
          top_issues: [],
          new_issues: []
        })
      ]
    });
  });

  it('keeps backend issues visible when frontend fills its own limit, with all production service environments selected', async () => {
    process.env.MONITORING_SENTRY_PROJECTS = '6529-frontend;seize-backend';
    process.env.MONITORING_SENTRY_ENVIRONMENT_FILTERS = 'production;*_prod';
    jest.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('query')).toContain(
        'tags[environment]:[*_prod,production]'
      );
      expect(url.searchParams.has('environment')).toBe(false);
      const project = url.searchParams.get('project');
      return response(
        project === '6529-frontend'
          ? Array.from({ length: 6 }, (_, index) => ({
              ...issue(String(index)),
              project: { slug: project }
            }))
          : [{ ...issue('777'), project: { slug: 'seize-backend' } }]
      );
    });
    const result = await getSentryOverview();
    expect(result.environment).toBe('production');
    expect(result.projects).toHaveLength(2);
    expect(result.projects[0].top_issues).toHaveLength(5);
    expect(result.projects[0].top_issues_has_more).toBe(true);
    expect(result.projects[1]).toMatchObject({
      project: 'seize-backend',
      top_issues: [expect.objectContaining({ id: '777', occurrences: 12 })],
      top_issues_has_more: false
    });
  });

  it.each(['*', 'production;!environment:staging', '*_prod;'])(
    'rejects unsafe or unrestricted environment filters: %s',
    async (filters) => {
      process.env.MONITORING_SENTRY_ENVIRONMENT_FILTERS = filters;
      await expect(getSentryOverview()).rejects.toThrow(
        'Invalid Sentry monitoring configuration'
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('uses a separate cache key after project, environment, filters or token changes', async () => {
    await getSentryOverview();
    process.env.MONITORING_SENTRY_PROJECTS = 'other';
    await getSentryOverview();
    process.env.MONITORING_SENTRY_ENVIRONMENT = 'staging';
    await getSentryOverview();
    process.env.MONITORING_SENTRY_ENVIRONMENT_FILTERS = 'production;*_prod';
    await getSentryOverview();
    process.env.MONITORING_SENTRY_TOKEN = 'rotated';
    await getSentryOverview();
    const keys = jest.mocked(redisCached).mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(5);
    expect(keys.join(' ')).not.toContain('private-test-token');
  });

  it('reuses a cached snapshot without calling Sentry', async () => {
    const snapshot = await getSentryOverview();
    jest.mocked(fetch).mockClear();
    jest.mocked(redisCached).mockResolvedValue(snapshot);
    expect(await getSentryOverview()).toEqual(snapshot);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares concurrent collection and retries after failure', async () => {
    const [a, b] = await Promise.all([
      getSentryOverview(),
      getSentryOverview()
    ]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(14);
    jest.mocked(fetch).mockRejectedValueOnce(new Error('timeout'));
    await expect(getSentryOverview()).rejects.toThrow();
    await expect(getSentryOverview()).resolves.toMatchObject({
      status: 'ready'
    });
  });

  it.each([
    null,
    {},
    [{ ...issue(), filtered: { count: '-1' } }],
    [{ ...issue(), id: '../../private' }]
  ])('rejects malformed provider data', async (body) => {
    jest.mocked(fetch).mockResolvedValue(response(body));
    await expect(getSentryOverview()).rejects.toThrow();
  });

  it('rejects provider HTTP errors', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValue(response({ secret: 'provider body' }, false));
    await expect(getSentryOverview()).rejects.toThrow('Sentry request failed');
  });

  it('rejects wildcard or URL-like configuration before collection', async () => {
    process.env.MONITORING_SENTRY_PROJECTS = '-1';
    await expect(getSentryOverview()).rejects.toThrow();
    process.env.MONITORING_SENTRY_ORG = 'https://untrusted.example';
    await expect(getSentryOverview()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts priority and change groups independently of the frequent issue preview', async () => {
    process.env.MONITORING_SENTRY_PROJECTS = 'web';
    jest.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      const query = url.searchParams.get('query')!;
      if (query.includes('issue.priority:high'))
        return response([issue('900')], true, {
          'x-hits': '9',
          'x-max-hits': '1000'
        });
      if (query.includes('is:regressed'))
        return response([{ ...issue('901'), substatus: 'regressed' }]);
      if (query.includes('is:escalating'))
        return response([{ ...issue('902'), substatus: 'escalating' }]);
      return response([
        { ...issue('123'), level: 'warning', priority: 'medium' }
      ]);
    });
    const project = (await getSentryOverview()).projects[0];
    expect(project.high_priority).toMatchObject({
      count: 9,
      count_exact: true,
      issues: [{ id: '900' }]
    });
    expect(project.top_issues[0]).toMatchObject({
      level: 'warning',
      priority: 'medium'
    });
    expect(project.regressed.issues[0].state).toBe('regressed');
    expect(project.escalating.issues[0].state).toBe('escalating');
  });

  it.each([
    { 'x-hits': '1000', 'x-max-hits': '1000' },
    { 'x-hits': '9' },
    { 'x-hits': 'invalid', 'x-max-hits': '1000' }
  ])(
    'keeps capped or unverifiable counts as lower bounds: %j',
    async (headers) => {
      jest.mocked(fetch).mockResolvedValue(
        response(
          Array.from({ length: 6 }, (_, index) => issue(String(index))),
          true,
          headers
        )
      );
      expect(
        (await getSentryOverview()).projects[0].high_priority
      ).toMatchObject({ count: 6, count_exact: false, has_more: true });
    }
  );

  it('compares all captured events in adjacent windows, including resolved issues and warnings', async () => {
    process.env.MONITORING_SENTRY_PROJECTS = 'web';
    const windows: Array<{ start: string; end: string }> = [];
    jest.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('limit') !== '50') return response([issue()]);
      expect(url.searchParams.get('query')).toBe(
        'issue.category:error tags[environment]:[production]'
      );
      const window = {
        start: url.searchParams.get('start')!,
        end: url.searchParams.get('end')!
      };
      windows.push(window);
      const current = windows.length === 1;
      return response([
        {
          ...issue(current ? '1' : '2'),
          status: 'resolved',
          level: 'warning',
          filtered: { count: current ? '30' : '10' }
        }
      ]);
    });
    expect((await getSentryOverview()).projects[0].event_trend).toEqual({
      current_events: 30,
      previous_events: 10
    });
    expect(windows[1].end).toBe(windows[0].start);
    expect(Date.parse(windows[0].end) - Date.parse(windows[1].start)).toBe(
      172_800_000
    );
  });

  it('follows only cursor values on the fixed provider URL to collect beyond the first page', async () => {
    process.env.MONITORING_SENTRY_PROJECTS = 'web';
    jest.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('limit') !== '50') return response([issue()]);
      expect(url.origin).toBe('https://sentry.io');
      if (!url.searchParams.has('cursor'))
        return response(
          Array.from({ length: 50 }, (_, i) => issue(String(i))),
          true,
          {
            link: '<https://untrusted.example/>; rel="next"; results="true"; cursor="1:50:0"'
          }
        );
      expect(url.searchParams.get('cursor')).toBe('1:50:0');
      return response([issue('51')], true, {
        link: '<https://sentry.io/>; rel="next"; results="false"; cursor="0:0:0"'
      });
    });
    expect((await getSentryOverview()).projects[0].event_trend).toEqual({
      current_events: 612,
      previous_events: 612
    });
  });

  it('keeps trend unavailable when pagination hits the bound or repeats an issue', async () => {
    process.env.MONITORING_SENTRY_PROJECTS = 'web';
    jest.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('limit') !== '50') return response([issue()]);
      const page = Number(url.searchParams.get('cursor')?.split(':')[1] ?? 0);
      return response(
        Array.from({ length: 50 }, (_, i) => issue(String(page * 50 + i))),
        true,
        {
          link: `<https://sentry.io/>; rel="next"; results="true"; cursor="1:${page + 1}:0"`
        }
      );
    });
    expect((await getSentryOverview()).projects[0].event_trend).toEqual({
      current_events: null,
      previous_events: null
    });
    expect(fetch).toHaveBeenCalledTimes(15);
  });

  it('retains the issue overview when trend collection fails', async () => {
    jest
      .mocked(fetch)
      .mockImplementation(async (input) =>
        new URL(String(input)).searchParams.get('limit') === '50'
          ? response({}, false)
          : response([issue()])
      );
    const result = await getSentryOverview();
    expect(result.status).toBe('ready');
    expect(result.projects[0].high_priority.count).toBe(1);
    expect(result.projects[0].event_trend).toEqual({
      current_events: null,
      previous_events: null
    });
  });

  it('marks unfamiliar severity, priority and status values as unknown', async () => {
    jest.mocked(fetch).mockResolvedValue(
      response([
        {
          ...issue(),
          level: 'custom',
          priority: 'critical',
          status: 'custom'
        }
      ])
    );
    expect((await getSentryOverview()).projects[0].top_issues[0]).toMatchObject(
      { level: 'unknown', priority: 'unknown', state: 'unknown' }
    );
  });
});
