import express from 'express';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import telemetryDiagnosticsRoutes from '@/api/telemetry/telemetry-diagnostics.routes';
import { resetTelemetryDailySaltForTests } from '@/api/telemetry/telemetry-daily-salt';
import {
  readDiagnostics,
  decodeDiagnosticsRequest,
  DIAG_MAX_UNCOMPRESSED_BYTES
} from '@/api/telemetry/telemetry-diagnostics';
import { DIAGNOSTICS_CODE_PATTERN } from '@/api/telemetry/telemetry-diagnostics-crypto';

const mockLogLines: string[] = [];
const mockSql: { sql: string; params: any }[] = [];
const mockRows = new Map<string, any>();
const mockRedisKeys: string[] = [];
let mockRateLimitCount = 1;

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
    execute: jest.fn(async (sql: string, params: any) => {
      mockSql.push({ sql, params });
      if (sql.includes('INSERT IGNORE')) {
        mockRows.set(params.code, { ...params });
        return { affectedRows: 1 };
      }
      return { affectedRows: 0 };
    }),
    oneOrNull: jest.fn(async (_sql: string, params: any) => {
      const row = mockRows.get(params.code);
      return row && row.expires_at > params.now ? row : null;
    }),
    getAffectedRows: (result: any) => result?.affectedRows ?? 0
  }
}));

jest.mock('@/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    set: async (key: string) => {
      mockRedisKeys.push(key);
      return 'OK';
    },
    get: async () => Buffer.alloc(32, 7).toString('base64')
  }),
  redisSortedSetAddAndCount: async (key: string) => {
    mockRedisKeys.push(key);
    return mockRateLimitCount;
  }
}));

const SENDER_IP = '198.51.100.23';
const USER_AGENT = 'DiagProbeAgent/3.1';
const bundleJson = { v: 1, app: { version: '1.2.3' }, entries: ['ok'] };

function gzipRequest(json: unknown = bundleJson) {
  return {
    v: 1,
    encoding: 'gzip',
    data: gzipSync(Buffer.from(JSON.stringify(json))).toString('base64')
  };
}

describe('POST /api/e/diag', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof express>['listen']>;

  beforeAll(async () => {
    const app = express();
    app.use('/api/e/diag', telemetryDiagnosticsRoutes);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/e/diag`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.TELEMETRY_DIAG_KEY;
  });

  beforeEach(() => {
    process.env.TELEMETRY_DIAG_KEY = randomBytes(32).toString('base64');
    mockLogLines.length = 0;
    mockSql.length = 0;
    mockRows.clear();
    mockRedisKeys.length = 0;
    mockRateLimitCount = 1;
    resetTelemetryDailySaltForTests();
  });

  function post(body: unknown) {
    return fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-forwarded-for': SENDER_IP
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
  }

  it('stores an encrypted bundle and returns a short code', async () => {
    const response = await post(gzipRequest());
    expect(response.status).toBe(201);
    const receipt = (await response.json()) as any;
    expect(receipt.code).toMatch(DIAGNOSTICS_CODE_PATTERN);
    const expires = Date.parse(receipt.expires_at) - Date.now();
    expect(expires).toBeGreaterThan(13.9 * 24 * 3600 * 1000);
    expect(expires).toBeLessThanOrEqual(14 * 24 * 3600 * 1000);

    const stored = mockRows.get(receipt.code);
    expect(Buffer.isBuffer(stored.ciphertext)).toBe(true);
    expect(stored.ciphertext.toString('latin1')).not.toContain('1.2.3');

    const read = await readDiagnostics(receipt.code, new Date());
    expect(read?.bundle).toEqual(bundleJson);
  });

  it('never stores or logs the sender', async () => {
    await post(gzipRequest());
    const recorded = JSON.stringify({
      mockLogLines,
      params: mockSql.map(({ params }) => ({
        ...params,
        ciphertext: undefined,
        iv: undefined,
        auth_tag: undefined
      })),
      mockRedisKeys
    });
    for (const value of [SENDER_IP, '127.0.0.1', USER_AGENT, 'DiagProbe']) {
      expect(recorded).not.toContain(value);
    }
    const rateLimitKeys = mockRedisKeys.filter((key) =>
      key.includes('telemetry-diag')
    );
    expect(rateLimitKeys.length).toBeGreaterThan(0);
    for (const key of rateLimitKeys) {
      expect(key).toMatch(/telemetry-diag:[0-9a-f]{32}/);
    }
  });

  it('limits each visitor', async () => {
    mockRateLimitCount = 100;
    const response = await post(gzipRequest());
    expect(response.status).toBe(429);
    expect(mockRows.size).toBe(0);
  });

  it('is unavailable without an encryption key', async () => {
    delete process.env.TELEMETRY_DIAG_KEY;
    const response = await post(gzipRequest());
    expect(response.status).toBe(503);
    expect(mockRows.size).toBe(0);
  });

  it('rejects invalid and oversized bundles without logging them', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ v: 1, encoding: 'gzip', data: '%%%' })).status).toBe(
      400
    );
    expect((await post(gzipRequest([1, 2, 3]))).status).toBe(400);
    expect(
      (
        await post({
          v: 1,
          encoding: 'identity',
          data: randomBytes(300 * 1024).toString('base64')
        })
      ).status
    ).toBe(413);
    expect(mockRows.size).toBe(0);
    expect(mockLogLines.join('\n')).not.toContain('not json');
  });
});

describe('decodeDiagnosticsRequest', () => {
  it('refuses gzip bombs above 2 MiB', () => {
    const bomb = gzipSync(Buffer.alloc(DIAG_MAX_UNCOMPRESSED_BYTES + 1, 32));
    expect(() =>
      decodeDiagnosticsRequest({
        v: 1,
        encoding: 'gzip',
        data: bomb.toString('base64')
      })
    ).toThrow(expect.objectContaining({ status: 413 }));
  });

  it('compresses identity bundles before storage', () => {
    const json = Buffer.from(
      JSON.stringify({ v: 1, filler: 'a'.repeat(5000) })
    );
    const decoded = decodeDiagnosticsRequest({
      v: 1,
      encoding: 'identity',
      data: json.toString('base64')
    });
    expect(decoded.uncompressedBytes).toBe(json.length);
    expect(decoded.gzip.length).toBeLessThan(json.length);
  });
});
