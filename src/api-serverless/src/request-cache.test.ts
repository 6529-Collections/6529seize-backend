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
import { get as httpGet, Server } from 'node:http';
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
  let requestCounter = 0;
  app.use((_req, res, next) => {
    requestCounter += 1;
    res.setHeader('X-Request-Id', `request-${requestCounter}`);
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
    requestId: response.headers.get('x-request-id'),
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

  it('never stores or replays the request id of the response that filled the cache', async () => {
    await withServer({}, async (baseUrl) => {
      const first = await get(baseUrl);
      expect(first.requestId).toBe('request-1');
      await waitForCacheEntries(1);
      expect(Array.from(mockCacheStore.values()).join('')).not.toMatch(
        /x-request-id/i
      );
      const second = await get(baseUrl);
      expect(second.cache).toBe('HIT');
      expect(second.requestId).toBe('request-2');
    });
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

describe('cacheRequest stored responses', () => {
  const originalMaxBytes = process.env.REQUEST_CACHE_MAX_BODY_BYTES;

  beforeEach(() => {
    mockCacheStore.clear();
  });

  afterEach(() => {
    if (originalMaxBytes === undefined) {
      delete process.env.REQUEST_CACHE_MAX_BODY_BYTES;
    } else {
      process.env.REQUEST_CACHE_MAX_BODY_BYTES = originalMaxBytes;
    }
  });

  async function withRoute<T>(
    respond: (req: Request, res: Response, calls: number) => void,
    callback: (url: string, handlerCalls: () => number) => Promise<T>
  ): Promise<T> {
    let calls = 0;
    const app = express();
    app.get('/thing', cacheRequest(), (req: Request, res: Response) => {
      calls++;
      respond(req, res, calls);
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected test server to listen on a TCP port');
      }
      return await callback(
        `http://127.0.0.1:${address.port}/thing`,
        () => calls
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  // fetch() turns conditional requests into Cache-Control: no-cache ones,
  // which Express never answers with 304, so use a plain HTTP request.
  function conditionalGet(
    url: string,
    ifNoneMatch: string
  ): Promise<{ status: number; cache: string | undefined; body: string }> {
    return new Promise((resolve, reject) => {
      httpGet(url, { headers: { 'if-none-match': ifNoneMatch } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            cache: res.headers['x-cache'] as string | undefined,
            body
          })
        );
      }).on('error', reject);
    });
  }

  it('does not store the 304 answering If-None-Match: * on a miss', async () => {
    await withRoute(
      (_req, res, calls) => res.json({ calls }),
      async (url, handlerCalls) => {
        const conditional = await conditionalGet(url, '*');
        expect(conditional.status).toBe(304);
        await settle();
        expect(mockCacheStore.size).toBe(0);

        const plain = await fetch(url);
        expect(plain.status).toBe(200);
        expect(plain.headers.get('x-cache')).toBe('MISS');
        expect(await plain.json()).toEqual({ calls: 2 });
        expect(handlerCalls()).toBe(2);
      }
    );
  });

  it('answers conditional requests from a cached 200', async () => {
    await withRoute(
      (_req, res, calls) => res.json({ calls }),
      async (url, handlerCalls) => {
        const first = await fetch(url);
        const etag = first.headers.get('etag');
        expect(etag).toBeTruthy();
        await waitForCacheEntries(1);

        const matching = await conditionalGet(url, etag!);
        expect(matching.status).toBe(304);
        expect(matching.cache).toBe('HIT');
        expect(matching.body).toBe('');

        const stale = await conditionalGet(url, '"something-else"');
        expect(stale.status).toBe(200);
        expect(JSON.parse(stale.body)).toEqual({ calls: 1 });

        const plain = await fetch(url);
        expect(plain.status).toBe(200);
        expect(await plain.json()).toEqual({ calls: 1 });
        expect(handlerCalls()).toBe(1);
      }
    );
  });

  it('stores only 200 responses by default', async () => {
    for (const status of [201, 204, 206, 404, 500]) {
      mockCacheStore.clear();
      await withRoute(
        (_req, res) => {
          res.status(status).send(status === 204 ? undefined : 'body');
        },
        async (url) => {
          await fetch(url);
          await settle();
          expect(mockCacheStore.size).toBe(0);
        }
      );
    }
  });

  it('skips storing bodies above the configured size cap', async () => {
    process.env.REQUEST_CACHE_MAX_BODY_BYTES = '100';
    await withRoute(
      (_req, res) => res.json({ payload: 'x'.repeat(200) }),
      async (url, handlerCalls) => {
        const first = await fetch(url);
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as { payload: string };
        expect(firstBody.payload).toHaveLength(200);
        await settle();
        expect(mockCacheStore.size).toBe(0);
        expect((await fetch(url)).headers.get('x-cache')).toBe('MISS');
        expect(handlerCalls()).toBe(2);
      }
    );
  });

  it('stores bodies at or below the size cap', async () => {
    process.env.REQUEST_CACHE_MAX_BODY_BYTES = '100';
    await withRoute(
      (_req, res) => res.json({ ok: true }),
      async (url) => {
        await fetch(url);
        await waitForCacheEntries(1);
        expect((await fetch(url)).headers.get('x-cache')).toBe('HIT');
      }
    );
  });

  it('treats a previously stored 304 entry as a miss', async () => {
    await withRoute(
      (_req, res, calls) => res.json({ calls }),
      async (url, handlerCalls) => {
        mockCacheStore.set(
          `__SEIZE_CACHE_${process.env.NODE_ENV}__/thing`,
          JSON.stringify({
            __requestCache: true,
            statusCode: 304,
            headers: {},
            body: ''
          })
        );
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-cache')).toBe('MISS');
        expect(await response.json()).toEqual({ calls: 1 });
        expect(handlerCalls()).toBe(1);
      }
    );
  });
});
