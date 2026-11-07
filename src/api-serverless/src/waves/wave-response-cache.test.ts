const mockCacheStore = new Map<string, string>();

jest.mock('@/redis', () => ({
  redisGet: jest.fn(async (key: string) => {
    const stored = mockCacheStore.get(key);
    return stored ? JSON.parse(stored) : null;
  }),
  redisSetJson: jest.fn(async (key: string, value: unknown, ttl: unknown) => {
    mockCacheStore.set(key, JSON.stringify(value));
    mockTtls.push(ttl);
  })
}));
const mockTtls: unknown[] = [];

import express, { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { get as httpGet, Server } from 'node:http';
import type { ApiWave } from '@/api/generated/models/ApiWave';
import {
  ANONYMOUS_WAVE_RESPONSE_TTL,
  anonymousWaveResponseCache,
  carriesIdentity,
  carriesViewerState,
  markShareableWaveResponse
} from './wave-response-cache';

/** An anonymous wave response: every per-viewer field at its default. */
function anonymousWave(overrides: Record<string, unknown> = {}): ApiWave {
  return {
    id: 'wave-1',
    name: 'Announcements',
    subscribed_actions: [],
    pinned: false,
    identity_wave: false,
    metrics: {
      subscribers_count: 10,
      drops_count: 5,
      latest_drop_timestamp: 1000,
      your_drops_count: undefined,
      your_latest_drop_timestamp: undefined,
      your_participation_drops_count: 0,
      your_unread_drops_count: 0,
      first_unread_drop_serial_no: undefined,
      your_latest_read_timestamp: 0,
      muted: false
    },
    description_drop: {
      id: 'drop-1',
      context_profile_context: null,
      subscribed_actions: [],
      reactions: [{ reaction: ':fire:', count: 71 }]
    },
    ...overrides
  } as unknown as ApiWave;
}

describe('carriesViewerState', () => {
  it('is false for an anonymous wave response', () => {
    expect(carriesViewerState(anonymousWave())).toBe(false);
  });

  const withMetric = (field: string, value: unknown) =>
    anonymousWave({
      metrics: { ...anonymousWave().metrics, [field]: value }
    });

  it.each([
    ['subscriptions', anonymousWave({ subscribed_actions: ['DROP_CREATED'] })],
    ['a pin', anonymousWave({ pinned: true })],
    ['own drops', withMetric('your_drops_count', 3)],
    ['own latest drop', withMetric('your_latest_drop_timestamp', 5)],
    ['participation', withMetric('your_participation_drops_count', 1)],
    ['unread count', withMetric('your_unread_drops_count', 2)],
    ['first unread', withMetric('first_unread_drop_serial_no', 9)],
    ['read position', withMetric('your_latest_read_timestamp', 9)],
    ['a mute', withMetric('muted', true)],
    [
      'rep contribution',
      anonymousWave({ wave_rep: { authenticated_user_contribution: 5 } })
    ],
    [
      'own context on the description drop',
      anonymousWave({
        description_drop: {
          ...anonymousWave().description_drop,
          context_profile_context: { reaction: ':fire:' }
        }
      })
    ],
    [
      'description drop subscriptions',
      anonymousWave({
        description_drop: {
          ...anonymousWave().description_drop,
          subscribed_actions: ['VOTED']
        }
      })
    ],
    [
      'parent wave context',
      anonymousWave({ parent_wave: { context_profile_context: {} } })
    ]
  ])('is true when the response holds %s', (_label, wave) => {
    expect(carriesViewerState(wave)).toBe(true);
  });
});

describe('carriesIdentity', () => {
  const req = (headers: Record<string, string>, user?: unknown) =>
    ({ headers, user }) as unknown as Request;

  it.each([
    ['a verified user', req({}, { wallet: '0xabc' })],
    ['an Authorization header', req({ authorization: 'Bearer anything' })],
    ['the wallet-auth cookie', req({ cookie: 'a=1; wallet-auth=x' })],
    ['the __Host-wallet-auth cookie', req({ cookie: '__Host-wallet-auth=x' })]
  ])('is true for %s', (_label, request) => {
    expect(carriesIdentity(request)).toBe(true);
  });

  it('is false for an anonymous request, other cookies included', () => {
    expect(carriesIdentity(req({ cookie: 'theme=dark' }))).toBe(false);
  });
});

/**
 * A conditional GET without fetch: fetch marks conditional requests
 * `Cache-Control: no-cache`, which makes Express skip its 304.
 */
function conditionalGet(
  url: string,
  etag: string
): Promise<{ status: number; xCache: string | undefined }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers: { 'if-none-match': etag } }, (res) => {
      res.resume();
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          xCache: res.headers['x-cache'] as string | undefined
        })
      );
    }).on('error', reject);
  });
}

describe('anonymous GET /waves/:id response cache', () => {
  let handlerCalls = 0;
  let requestCounter = 0;
  let stdout: jest.SpyInstance;
  const lambda = process.env.AWS_LAMBDA_FUNCTION_NAME;

  beforeEach(() => {
    mockCacheStore.clear();
    mockTtls.length = 0;
    handlerCalls = 0;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    if (lambda === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = lambda;
  });

  async function withServer<T>(
    callback: (baseUrl: string) => Promise<T>
  ): Promise<T> {
    const app = express();
    app.use((req, res, next) => {
      requestCounter += 1;
      res.setHeader('X-Request-Id', `request-${requestCounter}`);
      // Stands in for maybeAuthenticatedUser(): only a valid token sets it.
      if (req.headers.authorization === 'Bearer valid') {
        req.user = { wallet: '0xviewer', role: null };
      }
      next();
    });
    app.get(
      '/waves/:id',
      anonymousWaveResponseCache(),
      (req: Request, res: Response) => {
        handlerCalls++;
        if (req.params.id === 'missing') {
          res.status(404).json({ error: 'Wave not found' });
          return;
        }
        const viewer = req.user ? '0xviewer' : null;
        const wave =
          req.params.id === 'leaky'
            ? anonymousWave({ pinned: true })
            : viewer
              ? anonymousWave({ pinned: true, subscribed_actions: ['DROP'] })
              : anonymousWave();
        markShareableWaveResponse(res, viewer, wave);
        res.send(wave);
      }
    );
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('port');
      return await callback(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }

  const outcomes = () =>
    stdout.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line));
        } catch {
          return null;
        }
      })
      .filter((record) => record?.Route === 'GET /waves/:id')
      .map((record) =>
        record.CacheHit ? 'hit' : record.CacheMiss ? 'miss' : 'bypass'
      );

  it('serves the second anonymous request from the cache for 15 s, with its own request id', async () => {
    await withServer(async (base) => {
      const first = await fetch(`${base}/waves/wave-1?x=1`);
      const second = await fetch(`${base}/waves/wave-1?x=1`);
      expect(handlerCalls).toBe(1);
      expect(first.headers.get('x-cache')).toBe('MISS');
      expect(second.headers.get('x-cache')).toBe('HIT');
      expect(await second.json()).toEqual(await first.json());
      // The request id is never replayed from the cached response.
      expect(second.headers.get('x-request-id')).not.toBe(
        first.headers.get('x-request-id')
      );
      expect(second.headers.get('x-request-id')).toMatch(/^request-\d+$/);
      // A different query string is a different entry.
      await fetch(`${base}/waves/wave-1?x=2`);
      expect(handlerCalls).toBe(2);
    });
    expect(mockTtls[0]).toBe(ANONYMOUS_WAVE_RESPONSE_TTL);
    expect(outcomes()).toEqual(['miss', 'hit', 'miss']);
  });

  it.each([
    ['a valid token', { authorization: 'Bearer valid' }],
    ['an unverified Authorization header', { authorization: 'Bearer bad' }],
    ['the wallet-auth cookie', { cookie: 'wallet-auth=x' }]
  ])(
    'never serves or fills the cache for a request with %s',
    async (_label, headers) => {
      await withServer(async (base) => {
        await fetch(`${base}/waves/wave-1`); // anonymous: fills the cache
        const signedIn1 = await fetch(`${base}/waves/wave-1`, { headers });
        const signedIn2 = await fetch(`${base}/waves/wave-1`, { headers });
        expect(handlerCalls).toBe(3);
        expect(signedIn1.headers.get('x-cache')).toBeNull();
        expect(signedIn2.headers.get('x-cache')).toBeNull();
      });
      expect(mockCacheStore.size).toBe(1);
      expect(outcomes()).toEqual(['miss', 'bypass', 'bypass']);
    }
  );

  it('does not let a signed-in request fill the anonymous entry', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/waves/wave-1`, {
        headers: { authorization: 'Bearer valid' }
      });
      expect(mockCacheStore.size).toBe(0);
      const anonymous = await fetch(`${base}/waves/wave-1`);
      expect(anonymous.headers.get('x-cache')).toBe('MISS');
      const body = (await anonymous.json()) as ApiWave;
      expect(carriesViewerState(body)).toBe(false);
    });
  });

  it('stores only 200 responses: never a 404 or a 304', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/waves/missing`)).status).toBe(404);
      expect((await fetch(`${base}/waves/missing`)).status).toBe(404);
      expect(handlerCalls).toBe(2);

      const fresh = await fetch(`${base}/waves/wave-2`);
      const etag = fresh.headers.get('etag')!;
      mockCacheStore.clear();
      const notModified = await conditionalGet(`${base}/waves/wave-2`, etag);
      expect(notModified.status).toBe(304);
      expect(mockCacheStore.size).toBe(0);
    });
  });

  it('answers If-None-Match with 304 from a cached body', async () => {
    await withServer(async (base) => {
      const first = await fetch(`${base}/waves/wave-1`);
      const etag = first.headers.get('etag')!;
      const cached = await conditionalGet(`${base}/waves/wave-1`, etag);
      expect(cached.status).toBe(304);
      expect(cached.xCache).toBe('HIT');
      expect(handlerCalls).toBe(1);
    });
  });

  it('never stores a response that carries viewer state', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/waves/leaky`);
      await fetch(`${base}/waves/leaky`);
      expect(handlerCalls).toBe(2);
    });
    expect(mockCacheStore.size).toBe(0);
  });
});

describe('waves router wiring', () => {
  // The async router wraps handlers, so the wiring is checked in the source.
  const source = readFileSync(path.join(__dirname, 'waves.routes.ts'), 'utf8');

  it('mounts the anonymous cache on GET /waves/:id after authentication', () => {
    expect(source).toMatch(
      /router\.get\(\s*'\/:id',\s*maybeAuthenticatedUser\(\),\s*anonymousWaveResponseCache\(\),/
    );
  });

  it('marks the response with the viewer before sending it', () => {
    expect(source).toMatch(
      /markShareableWaveResponse\(res, profileId, wave\);\s*res\.send\(wave\);/
    );
  });
});
