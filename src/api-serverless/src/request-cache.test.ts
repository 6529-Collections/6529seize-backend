const mockCacheStore = new Map<string, string>();

jest.mock('@/redis', () => ({
  redisGet: jest.fn(async (key: string) => {
    const stored = mockCacheStore.get(key);
    return stored ? JSON.parse(stored) : null;
  }),
  redisSetJson: jest.fn(async (key: string, value: unknown) => {
    mockCacheStore.set(key, JSON.stringify(value));
  })
}));

import express, { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Server } from 'node:http';
import { cacheRequest } from '@/api/request-cache';

const AUTH_SEPARATOR = '__AUTH__';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withServer<T>(
  options: Parameters<typeof cacheRequest>[0],
  callback: (baseUrl: string, handlerCalls: () => number) => Promise<T>
): Promise<T> {
  let calls = 0;
  const app = express();
  app.get('/data', cacheRequest(options), (req: Request, res: Response) => {
    calls++;
    res.json({ authorization: req.headers.authorization ?? null, calls });
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`, () => calls);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function waitForCacheEntries(count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (mockCacheStore.size >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} cache entries`);
}

async function get(baseUrl: string, authorization?: string) {
  const response = await fetch(`${baseUrl}/data`, {
    headers: authorization ? { authorization } : {}
  });
  return {
    cache: response.headers.get('x-cache'),
    body: (await response.json()) as { authorization: string | null }
  };
}

describe('cacheRequest', () => {
  beforeEach(() => {
    mockCacheStore.clear();
  });

  it('shares one cache entry per URL when not auth dependent', async () => {
    await withServer({}, async (baseUrl, handlerCalls) => {
      expect((await get(baseUrl, 'Bearer first')).cache).toBe('MISS');
      await waitForCacheEntries(1);
      const second = await get(baseUrl, 'Bearer second');
      expect(second.cache).toBe('HIT');
      expect(second.body.authorization).toBe('Bearer first');
      expect(handlerCalls()).toBe(1);
    });
  });

  describe('authDependent', () => {
    it('serves a cached response only to the caller that produced it', async () => {
      await withServer(
        { authDependent: true },
        async (baseUrl, handlerCalls) => {
          const first = await get(baseUrl, 'Bearer first');
          expect(first.cache).toBe('MISS');
          await waitForCacheEntries(1);

          const firstAgain = await get(baseUrl, 'Bearer first');
          expect(firstAgain.cache).toBe('HIT');
          expect(firstAgain.body.authorization).toBe('Bearer first');

          const second = await get(baseUrl, 'Bearer second');
          expect(second.cache).toBe('MISS');
          expect(second.body.authorization).toBe('Bearer second');

          const anonymous = await get(baseUrl);
          expect(anonymous.cache).toBe('MISS');
          expect(anonymous.body.authorization).toBeNull();
          expect(handlerCalls()).toBe(3);
        }
      );
    });

    it('shares one anonymous entry between callers without credentials', async () => {
      await withServer(
        { authDependent: true },
        async (baseUrl, handlerCalls) => {
          expect((await get(baseUrl)).cache).toBe('MISS');
          await waitForCacheEntries(1);
          expect((await get(baseUrl)).cache).toBe('HIT');
          expect(handlerCalls()).toBe(1);
        }
      );
    });

    it('stores a hash of the credential, never the credential itself', async () => {
      const token = 'Bearer super-secret-token';
      await withServer({ authDependent: true }, async (baseUrl) => {
        await get(baseUrl, token);
        await get(baseUrl);
        await waitForCacheEntries(2);
      });

      const keys = Array.from(mockCacheStore.keys());
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(key).not.toContain('super-secret-token');
      }
      const suffixes = keys.map((key) => key.split(AUTH_SEPARATOR)[1]);
      expect(suffixes).toEqual(
        expect.arrayContaining([sha256(token), 'anonymous'])
      );
    });

    it('does not let a literal "anonymous" credential collide with anonymous callers', async () => {
      await withServer({ authDependent: true }, async (baseUrl) => {
        expect((await get(baseUrl)).cache).toBe('MISS');
        await waitForCacheEntries(1);
        expect((await get(baseUrl, 'anonymous')).cache).toBe('MISS');
      });
    });
  });
});
