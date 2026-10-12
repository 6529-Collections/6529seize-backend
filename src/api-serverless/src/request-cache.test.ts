import express, { Request, Response } from 'express';
import { Server } from 'node:http';
import { initRedis } from '@/redis';
import { cacheRequest } from './request-cache';

const mockGet = jest.fn();
const mockSet = jest.fn();

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    isReady: true,
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: mockGet,
    set: mockSet
  }))
}));

const COMMAND_TIMEOUT_MS = 40;
const handler = jest.fn((_req: Request, res: Response) => {
  res.json({ fresh: true });
});

async function withServer<T>(callback: (baseUrl: string) => Promise<T>) {
  const app = express();
  app.get('/api/things', cacheRequest(), handler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('cacheRequest', () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
    await initRedis({
      failFast: {
        commandTimeoutMs: COMMAND_TIMEOUT_MS,
        connectTimeoutMs: 1_000,
        initialConnectTimeoutMs: 1_000,
        maxReconnectDelayMs: 1_000
      }
    });
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset().mockResolvedValue('OK');
    handler.mockClear();
  });

  it('serves a stored response entry without running the handler', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({
        __requestCache: true,
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ cached: true })).toString('base64')
      })
    );

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/things`);
      expect(response.headers.get('x-cache')).toBe('HIT');
      expect(await response.json()).toEqual({ cached: true });
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('never serves a legacy-format value stored under the request key', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({ count: 1, page: 1, next: null, data: [{ stale: 1 }] })
    );

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/things`);
      expect(response.headers.get('x-cache')).toBe('MISS');
      expect(await response.json()).toEqual({ fresh: true });
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('falls through to the handler when the Redis read hangs', async () => {
    mockGet.mockImplementation(() => new Promise(() => undefined));

    await withServer(async (baseUrl) => {
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/api/things`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-cache')).toBe('MISS');
      expect(await response.json()).toEqual({ fresh: true });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
