import express from 'express';
import { AddressInfo } from 'node:net';
import { loggerContext } from '@/logger-context';
import { requestLogMiddleware } from '@/api/request-log.middleware';
import { DbPoolName } from '@/db-query.options';
import { SqlOperationTiming } from '@/db/sql-operation-timing';

const mockLogLines: { line: string; requestId: string | undefined }[] = [];

jest.mock('@/logging', () => {
  const record = (line: string) => {
    // Mirrors the real formatter, which prints the context request id.
    const { loggerContext: context } = jest.requireActual('@/logger-context');
    mockLogLines.push({ line, requestId: context.get()?.requestId });
  };
  return {
    Logger: {
      get: () => ({ info: record, warn: record, error: record, debug: record })
    }
  };
});

describe('requestLogMiddleware', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  const seenInHandler: (string | undefined)[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(requestLogMiddleware());
    app.get('/api/things', (_req, res) => {
      seenInHandler.push(loggerContext.get()?.requestId);
      res.json({ ok: true });
    });
    app.get('/api/with-sql', async (_req, res) => {
      await Promise.resolve();
      for (const pool of [DbPoolName.READ, 'supplied' as const]) {
        const timing = new SqlOperationTiming(pool, () => 'SELECT 1');
        if (pool !== 'supplied') timing.acquired();
        timing.queryStarted();
        timing.queryFinished(false);
        timing.finish('completed');
      }
      res.json({ ok: true });
    });
    app.post('/api/e', (_req, res) => {
      res.status(204).end();
    });
    app.use((_req, res) => {
      res.status(404).end();
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    mockLogLines.length = 0;
    seenInHandler.length = 0;
  });

  async function waitForLogLine() {
    for (
      let attempt = 0;
      attempt < 50 && mockLogLines.length === 0;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('returns X-Request-Id on every response and logs it with the request', async () => {
    const response = await fetch(`${baseUrl}/api/things?page=2`);
    const requestId = response.headers.get('x-request-id');

    expect(response.status).toBe(200);
    expect(requestId).toMatch(/^\S{6,}$/);
    expect(seenInHandler).toEqual([requestId]);
    await waitForLogLine();
    expect(mockLogLines).toEqual([
      expect.objectContaining({
        requestId,
        line: expect.stringContaining('[PATH /api/things?page=2]')
      })
    ]);
  });

  it("logs the request's SQL operation count and time split", async () => {
    await fetch(`${baseUrl}/api/with-sql`);
    await waitForLogLine();
    expect(mockLogLines).toEqual([
      expect.objectContaining({
        line: expect.stringMatching(
          /\[TOOK_MS \d+\] \[SQL_OPS 2\] \[SQL_ACQUIRE_MS \d+\] \[SQL_ACQUIRE_MAX_MS \d+\] \[SQL_MS \d+\]$/
        )
      })
    ]);
  });

  it('keeps SQL totals of concurrent requests apart', async () => {
    await Promise.all([
      fetch(`${baseUrl}/api/with-sql`),
      fetch(`${baseUrl}/api/things`)
    ]);
    for (let attempt = 0; attempt < 50 && mockLogLines.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const lines = mockLogLines.map(({ line }) => line);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\[PATH \/api\/with-sql\].*\[SQL_OPS 2\]/),
        expect.stringMatching(/\[PATH \/api\/things\].*\[SQL_OPS 0\]/)
      ])
    );
  });

  it('sets the header on error and not-found responses too', async () => {
    const response = await fetch(`${baseUrl}/missing`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('gives each request its own id', async () => {
    const first = await fetch(`${baseUrl}/api/things`);
    const second = await fetch(`${baseUrl}/api/things`);
    expect(first.headers.get('x-request-id')).not.toBe(
      second.headers.get('x-request-id')
    );
  });

  it('never logs the query string of telemetry requests', async () => {
    const response = await fetch(`${baseUrl}/api/e?note=private-probe`, {
      method: 'POST'
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    await waitForLogLine();
    expect(mockLogLines.map(({ line }) => line).join('\n')).not.toContain(
      'private-probe'
    );
  });

  it('adds no user identifiers to the log line', async () => {
    await fetch(`${baseUrl}/api/things`, {
      headers: {
        authorization: 'Bearer probe-token',
        'user-agent': 'ProbeAgent/1.0'
      }
    });
    await waitForLogLine();
    const logged = mockLogLines.map(({ line }) => line).join('\n');
    expect(logged).not.toContain('probe-token');
    expect(logged).not.toContain('ProbeAgent');
    expect(logged).not.toContain('127.0.0.1');
  });
});
