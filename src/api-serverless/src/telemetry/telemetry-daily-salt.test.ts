import {
  getTelemetryDailySalt,
  nextUtcMidnightEpochSeconds,
  resetTelemetryDailySaltForTests,
  telemetryDailyHash,
  utcDay
} from '@/api/telemetry/telemetry-daily-salt';

const mockLogLines: string[] = [];
const mockSqlCalls: unknown[] = [];
const mockRedisStore = new Map<string, string>();
const mockRedisSets: { key: string; value: string; opts: any }[] = [];
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

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(async (...args: unknown[]) => {
      mockSqlCalls.push(args);
      return [];
    })
  }
}));

jest.mock('@/redis', () => ({
  getRedisClient: () => ({
    get isReady() {
      return mockRedisReady;
    },
    set: async (key: string, value: string, opts: any) => {
      mockRedisSets.push({ key, value, opts });
      if (opts?.NX && mockRedisStore.has(key)) {
        return null;
      }
      mockRedisStore.set(key, value);
      return 'OK';
    },
    get: async (key: string) => mockRedisStore.get(key) ?? null
  })
}));

describe('telemetry daily salt', () => {
  beforeEach(() => {
    mockLogLines.length = 0;
    mockSqlCalls.length = 0;
    mockRedisStore.clear();
    mockRedisSets.length = 0;
    mockRedisReady = true;
    resetTelemetryDailySaltForTests();
  });

  it('is random, shared through Redis memory and expires at the next UTC midnight', async () => {
    const now = new Date('2026-11-06T13:45:00Z');
    const salt = await getTelemetryDailySalt(now);

    expect(salt.shared).toBe(true);
    expect(salt.day).toBe('2026-11-06');
    expect(salt.salt).toHaveLength(32);
    expect(mockRedisSets).toHaveLength(1);
    expect(mockRedisSets[0].key).toBe('telemetry:salt:2026-11-06');
    expect(mockRedisSets[0].opts).toEqual({
      NX: true,
      EXAT: Date.parse('2026-11-07T00:00:00Z') / 1000
    });
    // A second instance reuses the stored salt instead of minting its own.
    const firstSalt = Buffer.from(salt.salt);
    resetTelemetryDailySaltForTests();
    const other = await getTelemetryDailySalt(now);
    expect(other.salt.equals(firstSalt)).toBe(true);
  });

  it('is never written to SQL or logs', async () => {
    const salt = await getTelemetryDailySalt(new Date('2026-11-06T01:00:00Z'));
    telemetryDailyHash(salt, 'probe');
    const encoded = salt.salt.toString('base64');
    const hex = salt.salt.toString('hex');

    expect(mockSqlCalls).toHaveLength(0);
    const logs = mockLogLines.join('\n');
    expect(logs).not.toContain(encoded);
    expect(logs).not.toContain(hex);
  });

  it('rotates at UTC midnight and wipes the previous salt from memory', async () => {
    const before = await getTelemetryDailySalt(
      new Date('2026-11-06T23:59:59Z')
    );
    const beforeCopy = Buffer.from(before.salt);
    const hashBefore = telemetryDailyHash(before, '203.0.113.1');

    const after = await getTelemetryDailySalt(new Date('2026-11-07T00:00:01Z'));
    expect(after.day).toBe('2026-11-07');
    expect(after.salt.equals(beforeCopy)).toBe(false);
    expect(before.salt.every((byte) => byte === 0)).toBe(true);
    expect(telemetryDailyHash(after, '203.0.113.1')).not.toBe(hashBefore);
  });

  it('loads the shared salt once for concurrent callers', async () => {
    const now = new Date('2026-11-06T09:00:00Z');
    const [a, b, c] = await Promise.all([
      getTelemetryDailySalt(now),
      getTelemetryDailySalt(now),
      getTelemetryDailySalt(now)
    ]);
    expect(mockRedisSets).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.salt.some((byte) => byte !== 0)).toBe(true);
  });

  it('falls back to a per-process salt that is not marked shared', async () => {
    mockRedisReady = false;
    const salt = await getTelemetryDailySalt(new Date('2026-11-06T10:00:00Z'));
    expect(salt.shared).toBe(false);
    expect(mockRedisSets).toHaveLength(0);
  });

  it('computes UTC day boundaries', () => {
    const now = new Date('2026-12-31T23:30:00Z');
    expect(utcDay(now)).toBe('2026-12-31');
    expect(nextUtcMidnightEpochSeconds(now)).toBe(
      Date.parse('2027-01-01T00:00:00Z') / 1000
    );
  });
});
