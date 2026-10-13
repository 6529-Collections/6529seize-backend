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
const viewers = new Map([
  ['Bearer first', { wallet: 'first', role: null }],
  ['Bearer refreshed-first', { wallet: 'FIRST', role: null }],
  ['Bearer second', { wallet: 'second', role: null }],
  ['Bearer proxy-first', { wallet: 'first', role: 'proxy-profile' }]
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withServer<T>(
  options: Parameters<typeof cacheRequest>[0],
  callback: (baseUrl: string, handlerCalls: () => number) => Promise<T>
): Promise<T> {
  let calls = 0;
  const app = express();
  app.use((req, _res, next) => {
    req.user = viewers.get(req.headers.authorization ?? '');
    next();
  });
  app.get('/data', cacheRequest(options), (req: Request, res: Response) => {
    calls++;
    const user = req.user as
      | { wallet: string; role: string | null }
      | undefined;
    res.json({
      viewer: user?.wallet.toLowerCase() ?? null,
      role: user?.role ?? null,
      calls
    });
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
    body: (await response.json()) as {
      viewer: string | null;
      role: string | null;
    }
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
      expect(second.body.viewer).toBe('first');
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
          expect(firstAgain.body.viewer).toBe('first');

          const second = await get(baseUrl, 'Bearer second');
          expect(second.cache).toBe('MISS');
          expect(second.body.viewer).toBe('second');

          const anonymous = await get(baseUrl);
          expect(anonymous.cache).toBe('MISS');
          expect(anonymous.body.viewer).toBeNull();
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

    it('hashes the verified viewer and never stores credentials in key names', async () => {
      const token = 'Bearer first';
      await withServer({ authDependent: true }, async (baseUrl) => {
        await get(baseUrl, token);
        await get(baseUrl);
        await waitForCacheEntries(2);
      });

      const keys = Array.from(mockCacheStore.keys());
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(key).not.toContain(token);
      }
      const suffixes = keys.map((key) => key.split(AUTH_SEPARATOR)[1]);
      expect(suffixes).toEqual(
        expect.arrayContaining([
          sha256(JSON.stringify(['first', null])),
          'anonymous'
        ])
      );
    });

    it('shares anonymous responses for rejected credentials regardless of header', async () => {
      await withServer({ authDependent: true }, async (baseUrl) => {
        expect((await get(baseUrl)).cache).toBe('MISS');
        await waitForCacheEntries(1);
        expect((await get(baseUrl, 'anonymous')).cache).toBe('HIT');
        expect((await get(baseUrl, 'Bearer invalid')).body.viewer).toBeNull();
        expect(mockCacheStore.size).toBe(1);
      });
    });

    it('shares entries across refreshed tokens and wallet casing for the same role', async () => {
      await withServer(
        { authDependent: true },
        async (baseUrl, handlerCalls) => {
          await get(baseUrl, 'Bearer first');
          await waitForCacheEntries(1);
          expect((await get(baseUrl, 'Bearer refreshed-first')).cache).toBe(
            'HIT'
          );
          expect(handlerCalls()).toBe(1);
        }
      );
    });

    it('isolates a wallet acting as a proxy from its own viewer response', async () => {
      await withServer(
        { authDependent: true },
        async (baseUrl, handlerCalls) => {
          await get(baseUrl, 'Bearer first');
          await waitForCacheEntries(1);
          const proxy = await get(baseUrl, 'Bearer proxy-first');
          expect(proxy).toMatchObject({
            cache: 'MISS',
            body: { viewer: 'first', role: 'proxy-profile' }
          });
          await waitForCacheEntries(2);
          expect((await get(baseUrl, 'Bearer proxy-first')).cache).toBe('HIT');
          expect(handlerCalls()).toBe(2);
        }
      );
    });
  });
});
