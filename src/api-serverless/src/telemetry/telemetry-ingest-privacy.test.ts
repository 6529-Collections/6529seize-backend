import express, { Request, Response } from 'express';
import { AddressInfo } from 'node:net';
import telemetryIngestRoutes, {
  handleTelemetryBatch
} from '@/api/telemetry/telemetry-ingest.routes';
import { resetTelemetryDailySaltForTests } from '@/api/telemetry/telemetry-daily-salt';
import { resetTelemetryDailyJobsForTests } from '@/api/telemetry/telemetry-retention';
import { resetTelemetryUniquesForTests } from '@/api/telemetry/telemetry-uniques';

const mockLogLines: string[] = [];
const mockSql: { sql: string; params: unknown }[] = [];
const mockRedisWrites: unknown[][] = [];
const mockRedisStore = new Map<string, string>();
let mockRateLimitCount = 1;

function mockRecord(...args: unknown[]) {
  mockLogLines.push(
    args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ')
  );
}

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: mockRecord,
      warn: mockRecord,
      error: mockRecord,
      debug: mockRecord
    })
  }
}));

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(async (sql: string, params: unknown) => {
      mockSql.push({ sql, params });
      return [];
    }),
    getAffectedRows: () => 0
  }
}));

jest.mock('@/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    set: async (key: string, value: string, opts: unknown) => {
      mockRedisWrites.push(['set', key, value, opts]);
      if (!mockRedisStore.has(key)) {
        mockRedisStore.set(key, value);
        return 'OK';
      }
      return null;
    },
    get: async (key: string) => mockRedisStore.get(key) ?? null,
    pfAdd: async (key: string, elements: string[]) => {
      mockRedisWrites.push(['pfadd', key, elements]);
      return 1;
    },
    pfCount: async () => 1,
    expireAt: async (key: string, at: number) => {
      mockRedisWrites.push(['expireat', key, at]);
      return true;
    }
  }),
  redisSortedSetAddAndCount: async (...args: unknown[]) => {
    mockRedisWrites.push(['zadd', ...args]);
    return mockRateLimitCount;
  }
}));

const VIEWER_IP = '203.0.113.77';
const SOCKET_IP = '198.51.100.9';
const USER_AGENT = 'Mozilla/5.0 (X11) PrivacyProbeAgent/9.9';
const FP = 'fpProbeValue1234';
const EDGE_SECRET = 'edge-secret-for-tests';

const batch = {
  v: 1,
  events: [
    {
      v: 1,
      t: 'pv',
      route: '/waves/[wave]',
      page_group: 'waves',
      prev_route: 'entry',
      referrer_domain: 'news.example.org',
      device: 'mobile',
      platform: 'ios',
      browser: 'safari',
      signed_in: false,
      fp: FP,
      ip: VIEWER_IP,
      user_agent: USER_AGENT,
      email: 'probe@example.org',
      url: 'https://6529.io/punkprobe?token=probe-token'
    },
    {
      v: 1,
      t: 'ev',
      route: '/',
      device: 'mobile',
      platform: 'ios',
      name: 'Homepage section seen',
      p: { section: 'Latest drop', handle: 'punkprobe' }
    },
    {
      v: 1,
      t: 'vitals',
      route: '/',
      device: 'mobile',
      platform: 'ios',
      lcp: 1800
    }
  ]
};

const FORBIDDEN = [
  VIEWER_IP,
  SOCKET_IP,
  USER_AGENT,
  'PrivacyProbeAgent',
  FP,
  'probe@example.org',
  'punkprobe',
  'probe-token'
];

function edgeRequest(body: string, headers: Record<string, string>) {
  return {
    body,
    headers: { 'user-agent': USER_AGENT, ...headers },
    socket: { remoteAddress: SOCKET_IP }
  } as unknown as Request;
}

function mockResponse() {
  const res = {
    headersSent: false,
    setHeader: jest.fn(),
    status: jest.fn(),
    end: jest.fn()
  };
  res.status.mockReturnValue(res);
  return res;
}

function everythingRecorded(): string {
  return JSON.stringify({ mockLogLines, mockSql, mockRedisWrites });
}

describe('telemetry ingest privacy', () => {
  beforeEach(() => {
    mockLogLines.length = 0;
    mockSql.length = 0;
    mockRedisWrites.length = 0;
    mockRedisStore.clear();
    mockRateLimitCount = 1;
    resetTelemetryDailySaltForTests();
    resetTelemetryDailyJobsForTests();
    resetTelemetryUniquesForTests();
    process.env.TELEMETRY_EDGE_SECRET = EDGE_SECRET;
  });

  afterAll(() => {
    delete process.env.TELEMETRY_EDGE_SECRET;
  });

  it('never lets an IP, user agent, fp or unknown field reach logs, SQL or Redis', async () => {
    const res = mockResponse();
    await handleTelemetryBatch(
      edgeRequest(JSON.stringify(batch), {
        'x-6529-edge-auth': EDGE_SECRET,
        'cloudfront-viewer-address': `${VIEWER_IP}:51234`,
        'cloudfront-viewer-country': 'DE'
      }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(204);
    expect(mockSql.some(({ sql }) => sql.includes('analytics_daily'))).toBe(
      true
    );
    const recorded = everythingRecorded();
    for (const value of FORBIDDEN) {
      expect(recorded).not.toContain(value);
    }
    // The trusted edge country is the only location data kept.
    expect(recorded).toContain('"DE"');
    // The rate-limit key is a salted hash, never the IP.
    const rateLimitKeys = mockRedisWrites
      .filter(([op]) => op === 'zadd')
      .map(([, key]) => String(key));
    expect(rateLimitKeys.length).toBeGreaterThan(0);
    for (const key of rateLimitKeys) {
      expect(key).toMatch(/telemetry-ingest:[0-9a-f]{32}/);
    }
    // The daily-uniques HyperLogLog only ever receives salted hashes.
    const visitorHashes = mockRedisWrites
      .filter(([op]) => op === 'pfadd')
      .flatMap(([, , elements]) => elements as string[]);
    expect(visitorHashes).toHaveLength(1);
    expect(visitorHashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores CloudFront headers that arrive without the edge secret', async () => {
    const res = mockResponse();
    await handleTelemetryBatch(
      edgeRequest(JSON.stringify(batch), {
        'x-6529-edge-auth': 'wrong',
        'cloudfront-viewer-address': `${VIEWER_IP}:51234`,
        'cloudfront-viewer-country': 'DE'
      }),
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(204);
    const recorded = everythingRecorded();
    expect(recorded).not.toContain('"DE"');
    for (const value of FORBIDDEN) {
      expect(recorded).not.toContain(value);
    }
  });

  it('rejects non-JSON bodies without logging them', async () => {
    const res = mockResponse();
    await handleTelemetryBatch(
      edgeRequest(`not json ${VIEWER_IP}`, {}),
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSql).toHaveLength(0);
    expect(everythingRecorded()).not.toContain(VIEWER_IP);
  });

  it('returns 429 when the salted-hash limiter is exhausted', async () => {
    mockRateLimitCount = 10_000;
    const res = mockResponse();
    await handleTelemetryBatch(
      edgeRequest(JSON.stringify(batch), {}),
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockSql).toHaveLength(0);
  });
});

describe('telemetry ingest over HTTP', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof express>['listen']>;

  beforeAll(async () => {
    const app = express();
    app.use('/api/e', telemetryIngestRoutes);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/e`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    mockSql.length = 0;
    mockLogLines.length = 0;
    mockRateLimitCount = 1;
  });

  it('accepts sendBeacon text/plain bodies', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(batch)
    });
    expect(response.status).toBe(204);
    expect(mockSql.length).toBeGreaterThan(0);
  });

  it('rejects bodies over 8 KB without recording them', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, events: [], pad: 'x'.repeat(9000) })
    });
    expect(response.status).toBe(413);
    expect(mockSql).toHaveLength(0);
    expect(mockLogLines.join('\n')).not.toContain('xxxxxxxx');
  });
});
