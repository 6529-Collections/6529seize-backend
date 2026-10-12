const mockCacheStore = new Map<string, string>();
const mockFetchDistributionOverview = jest.fn();

jest.mock('@/redis', () => ({
  redisGet: jest.fn(async (key: string) => {
    const stored = mockCacheStore.get(key);
    return stored ? JSON.parse(stored) : null;
  }),
  redisSetJson: jest.fn(async (key: string, value: unknown) => {
    mockCacheStore.set(key, JSON.stringify(value));
  }),
  evictRedisCacheForPathWithTimeout: jest.fn()
}));

jest.mock('@/api/auth/auth', () => {
  const { UnauthorisedException } = jest.requireActual('@/exceptions');
  return {
    needsAuthenticatedUser:
      () =>
      (
        req: { headers: Record<string, string>; user?: unknown },
        _res: unknown,
        next: (err?: unknown) => void
      ) => {
        const wallet = req.headers['x-test-wallet'];
        if (!wallet) {
          next(new UnauthorisedException('Needs authentication'));
          return;
        }
        req.user = { wallet };
        next();
      },
    getAuthenticatedWalletOrNull: (req: { user?: { wallet: string } }) =>
      req.user?.wallet.toLowerCase() ?? null,
    getWalletOrThrow: jest.fn()
  };
});

jest.mock('@/api/distributions/api.distributions.db', () => ({
  fetchDistributionOverview: mockFetchDistributionOverview,
  fetchDistributionPhaseAirdrops: jest.fn(),
  fetchDistributionPhases: jest.fn(),
  fetchDistributions: jest.fn()
}));

jest.mock('@/api/distributions/api.distributions.service', () => ({
  insertAutomaticAirdropsForPhase: jest.fn(),
  populateDistributionNormalized: jest.fn()
}));

jest.mock('@/api/distributions/github-distribution.service', () => ({
  githubDistributionService: {}
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { cacheKey } from '@/api/api-helpers';
import { ApiCompliantException } from '@/exceptions';
import { redisGet } from '@/redis';
import router from '@/api/distributions/api.distributions.routes';

const ADMIN_WALLET = '0x00000000000000000000000000000000000000aa';
const NON_ADMIN_WALLET = '0x00000000000000000000000000000000000000bb';
const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const OVERVIEW_PATH = `/api/distributions/${CONTRACT}/7/overview`;
const ADMIN_OVERVIEW = { phases: [{ name: 'Phase 0', total: 123 }] };

function createTestApp() {
  const app = express();
  app.use('/api', router);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res.status(err.getStatusCode()).send({ error: err.message });
      return;
    }
    res.status(500).send({ error: 'Something went wrong...' });
  });
  return app;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = await new Promise<Server>((resolve) => {
    const listening = createTestApp().listen(0, () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function getOverview(baseUrl: string, wallet?: string) {
  const response = await fetch(`${baseUrl}${OVERVIEW_PATH}`, {
    headers: wallet ? { 'x-test-wallet': wallet } : {}
  });
  return {
    status: response.status,
    cache: response.headers.get('x-cache'),
    body: await response.json()
  };
}

async function waitForCachedOverview() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (mockCacheStore.size > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the overview cache entry');
}

describe('GET /distributions/:contract/:id/overview authorization', () => {
  const originalAdminWallets = process.env.DISTRIBUTION_ADMIN_WALLETS;

  beforeAll(() => {
    process.env.DISTRIBUTION_ADMIN_WALLETS = ADMIN_WALLET;
  });

  afterAll(() => {
    if (originalAdminWallets === undefined) {
      delete process.env.DISTRIBUTION_ADMIN_WALLETS;
    } else {
      process.env.DISTRIBUTION_ADMIN_WALLETS = originalAdminWallets;
    }
  });

  beforeEach(() => {
    mockCacheStore.clear();
    mockFetchDistributionOverview.mockReset();
    mockFetchDistributionOverview.mockResolvedValue(ADMIN_OVERVIEW);
    jest.mocked(redisGet).mockClear();
  });

  it('serves the overview to admins and caches it', async () => {
    await withServer(async (baseUrl) => {
      const first = await getOverview(baseUrl, ADMIN_WALLET);
      expect(first).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: ADMIN_OVERVIEW
      });
      await waitForCachedOverview();

      const second = await getOverview(baseUrl, ADMIN_WALLET);
      expect(second).toMatchObject({
        status: 200,
        cache: 'HIT',
        body: ADMIN_OVERVIEW
      });
      expect(mockFetchDistributionOverview).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects non-admins even when an admin response is already cached', async () => {
    await withServer(async (baseUrl) => {
      await getOverview(baseUrl, ADMIN_WALLET);
      await waitForCachedOverview();
      mockFetchDistributionOverview.mockClear();
      jest.mocked(redisGet).mockClear();

      const response = await getOverview(baseUrl, NON_ADMIN_WALLET);

      expect(response.status).toBe(403);
      expect(response.cache).toBeNull();
      expect(response.body).toEqual({
        error: 'Only Subscription Admins can fetch distribution overview'
      });
      // Authorization runs before the cache is consulted.
      expect(redisGet).not.toHaveBeenCalled();
      expect(mockFetchDistributionOverview).not.toHaveBeenCalled();
    });
  });

  it('rejects non-admins for an entry seeded directly in the cache', async () => {
    mockCacheStore.set(
      cacheKey({ originalUrl: OVERVIEW_PATH } as Request),
      JSON.stringify({
        __requestCache: true,
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify(ADMIN_OVERVIEW)).toString('base64')
      })
    );

    await withServer(async (baseUrl) => {
      const nonAdmin = await getOverview(baseUrl, NON_ADMIN_WALLET);
      expect(nonAdmin.status).toBe(403);
      expect(nonAdmin.body).not.toMatchObject(ADMIN_OVERVIEW);

      const admin = await getOverview(baseUrl, ADMIN_WALLET);
      expect(admin).toMatchObject({
        status: 200,
        cache: 'HIT',
        body: ADMIN_OVERVIEW
      });
    });
  });

  it('rejects unauthenticated callers before touching the cache', async () => {
    await withServer(async (baseUrl) => {
      const response = await getOverview(baseUrl);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Needs authentication' });
      expect(redisGet).not.toHaveBeenCalled();
      expect(mockFetchDistributionOverview).not.toHaveBeenCalled();
    });
  });
});
