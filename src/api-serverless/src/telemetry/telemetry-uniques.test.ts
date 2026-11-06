import {
  anonymousVisitorHash,
  maybeFlushAnonymousVisitors,
  recordAnonymousVisitors,
  resetTelemetryUniquesForTests
} from '@/api/telemetry/telemetry-uniques';
import { TelemetryDailySalt } from '@/api/telemetry/telemetry-daily-salt';
import { sanitizeTelemetryBatch } from '@/api/telemetry/telemetry-sanitizer';

const mockPfAdds: { key: string; elements: string[] }[] = [];
const mockExpiries: { key: string; at: number }[] = [];
const mockUpserts: unknown[][] = [];
const mockLogLines: string[] = [];
const mockLocks = new Set<string>();
let mockPfCount = 0;
let mockRedisReady = true;

jest.mock('@/logging', () => ({
  Logger: {
    get: () => {
      const record = (...args: unknown[]) =>
        mockLogLines.push(args.map((a) => String(a)).join(' '));
      return { info: record, warn: record, error: record, debug: record };
    }
  }
}));

jest.mock('@/redis', () => ({
  getRedisClient: () => ({
    get isReady() {
      return mockRedisReady;
    },
    pfAdd: async (key: string, elements: string[]) => {
      mockPfAdds.push({ key, elements });
      return 1;
    },
    pfCount: async () => mockPfCount,
    expireAt: async (key: string, at: number) => {
      mockExpiries.push({ key, at });
      return true;
    },
    set: async (key: string) => {
      if (mockLocks.has(key)) {
        return null;
      }
      mockLocks.add(key);
      return 'OK';
    }
  })
}));

jest.mock('@/api/telemetry/telemetry-uniques.db', () => ({
  upsertUniquesDailyMax: async (...args: unknown[]) => {
    mockUpserts.push(args);
  }
}));

const salt = (day: string, byte: number): TelemetryDailySalt => ({
  day,
  salt: Buffer.alloc(32, byte),
  shared: true
});

const pageView = (fp?: string) => ({
  v: 1,
  t: 'pv',
  route: '/',
  device: 'desktop',
  platform: 'web',
  browser: 'firefox',
  ...(fp ? { fp } : {})
});

const viewer = { ip: '203.0.113.5', country: '', viaEdge: true };
const NOW = new Date('2026-11-06T12:00:00Z');

describe('anonymousVisitorHash', () => {
  const today = salt('2026-11-06', 1);

  it('is stable within a day and changes with the daily salt', () => {
    const a = anonymousVisitorHash(today, '203.0.113.5', 'chrome', null);
    expect(anonymousVisitorHash(today, '203.0.113.5', 'chrome', null)).toBe(a);
    expect(
      anonymousVisitorHash(salt('2026-11-07', 2), '203.0.113.5', 'chrome', null)
    ).not.toBe(a);
  });

  it('separates people behind one IP and browser when fp is sent (C52a)', () => {
    const one = anonymousVisitorHash(
      today,
      '203.0.113.5',
      'chrome',
      'fpOfPersonA'
    );
    const two = anonymousVisitorHash(
      today,
      '203.0.113.5',
      'chrome',
      'fpOfPersonB'
    );
    const none = anonymousVisitorHash(today, '203.0.113.5', 'chrome', null);
    expect(new Set([one, two, none]).size).toBe(3);
  });

  it('never contains the IP or fp', () => {
    const hash = anonymousVisitorHash(
      today,
      '203.0.113.5',
      'chrome',
      'fpProbe123'
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recordAnonymousVisitors', () => {
  beforeEach(() => {
    mockPfAdds.length = 0;
    mockExpiries.length = 0;
    mockUpserts.length = 0;
    mockLogLines.length = 0;
    mockLocks.clear();
    mockRedisReady = true;
    mockPfCount = 0;
    resetTelemetryUniquesForTests();
  });

  it('adds one salted hash per distinct visitor and expires the set after the day', async () => {
    const events = sanitizeTelemetryBatch({
      v: 1,
      events: [pageView('fpProbe1234'), pageView('fpProbe1234'), pageView()]
    });
    await recordAnonymousVisitors(events, viewer, salt('2026-11-06', 1), NOW);

    expect(mockPfAdds).toHaveLength(1);
    expect(mockPfAdds[0].key).toBe('telemetry:uniq:2026-11-06');
    expect(mockPfAdds[0].elements).toHaveLength(2);
    const written = JSON.stringify(mockPfAdds);
    expect(written).not.toContain('fpProbe1234');
    expect(written).not.toContain(viewer.ip);
    expect(mockExpiries[0].at).toBe(Date.parse('2026-11-07T06:00:00Z') / 1000);
  });

  it('skips counting without a shared salt or an IP', async () => {
    const events = sanitizeTelemetryBatch({ v: 1, events: [pageView()] });
    await recordAnonymousVisitors(
      events,
      viewer,
      { ...salt('2026-11-06', 1), shared: false },
      NOW
    );
    await recordAnonymousVisitors(
      events,
      { ...viewer, ip: '' },
      salt('2026-11-06', 1),
      NOW
    );
    expect(mockPfAdds).toHaveLength(0);
  });

  it('persists only the daily count, at most once per interval', async () => {
    mockPfCount = 42;
    await maybeFlushAnonymousVisitors(NOW);
    await maybeFlushAnonymousVisitors(new Date(NOW.getTime() + 1000));
    expect(mockUpserts).toEqual([['2026-11-06', 'anonymous_visitors', 42]]);
  });

  it('also finalizes yesterday shortly after midnight', async () => {
    mockPfCount = 7;
    await maybeFlushAnonymousVisitors(new Date('2026-11-07T00:10:00Z'));
    expect(mockUpserts).toEqual([
      ['2026-11-07', 'anonymous_visitors', 7],
      ['2026-11-06', 'anonymous_visitors', 7]
    ]);
  });
});
