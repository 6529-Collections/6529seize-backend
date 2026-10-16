const mockCacheStore = new Map<string, string>();
const mockPrepareDistributionPhase = jest.fn();

jest.mock('@/drop-forge/drop-forge.preparation', () => ({
  prepareDistributionPhase: mockPrepareDistributionPhase
}));

// The allowlist handler logs every step; keep the test output readable.
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    })
  }
}));

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

jest.mock('@/api/subscriptions/api.subscriptions.allowlist', () => ({
  ...jest.requireActual('@/api/subscriptions/api.subscriptions.allowlist'),
  validateDistribution: jest.fn(),
  getPublicSubscriptions: jest.fn(),
  fetchPhaseName: jest.fn(),
  fetchPhaseResults: jest.fn(),
  resetAllowlist: jest.fn(),
  splitAllowlistResults: jest.fn()
}));

jest.mock('@/api/subscriptions/api.subscriptions.db', () => ({
  fetchConsolidationAddresses: jest.fn(),
  fetchDetailsForConsolidationKey: jest.fn(),
  fetchFinalSubscription: jest.fn(),
  fetchFinalSubscriptionsByPhase: jest.fn(),
  fetchLogsForConsolidationKey: jest.fn(),
  fetchMemeSubscriptionCount: jest.fn(),
  fetchPastMemeSubscriptionCounts: jest.fn(),
  fetchRedeemedMemeSubscriptionCountsDownload: jest.fn(),
  fetchRedeemedSubscriptionsForConsolidationKey: jest.fn(),
  fetchSubscriptionUploads: jest.fn(),
  fetchTopUpsForConsolidationKey: jest.fn(),
  fetchUpcomingMemeSubscriptionCounts: jest.fn(),
  fetchUpcomingMemeSubscriptionStatusForConsolidationKey: jest.fn(),
  fetchUpcomingMemeSubscriptions: jest.fn(),
  updateSubscribeAllEditions: jest.fn(),
  updateSubscription: jest.fn(),
  updateSubscriptionCount: jest.fn(),
  updateSubscriptionMode: jest.fn()
}));

jest.mock('@/api/distributions/api.distributions.service', () => ({
  populateDistribution: jest.fn()
}));
jest.mock('@/db-api', () => ({ fetchEns: jest.fn() }));
jest.mock('@/delegationsLoop/db.delegations', () => ({
  fetchAirdropAddressForConsolidationKey: jest.fn(),
  fetchProcessedDelegations: jest.fn()
}));
jest.mock('@/nftsLoop/db.nfts', () => ({ getNft: jest.fn() }));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { cacheKey } from '@/api/api-helpers';
import { ApiCompliantException } from '@/exceptions';
import { redisGet } from '@/redis';
import router from '@/api/subscriptions/api.subscriptions.routes';

const ADMIN_WALLET = '0x00000000000000000000000000000000000000aa';
const NON_ADMIN_WALLET = '0x00000000000000000000000000000000000000bb';
const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const ALLOWLIST_PATH = `/api/subscriptions/allowlists/${CONTRACT}/7/allowlist-1/public`;
const ADMIN_ALLOWLIST = { airdrops: [{ wallet: '0xabc', amount: 2 }] };

function createTestApp() {
  const app = express();
  app.use('/api/subscriptions', router);
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

async function getAllowlist(baseUrl: string, wallet?: string) {
  const response = await fetch(`${baseUrl}${ALLOWLIST_PATH}`, {
    headers: wallet ? { 'x-test-wallet': wallet } : {}
  });
  return {
    status: response.status,
    cache: response.headers.get('x-cache'),
    body: await response.json()
  };
}

describe('GET /subscriptions/allowlists/:contract/:token_id/:allowlist_id/:phase_id authorization', () => {
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
    mockPrepareDistributionPhase.mockReset();
    mockPrepareDistributionPhase.mockResolvedValue({
      phase: 'Public',
      ...ADMIN_ALLOWLIST,
      airdrops_unconsolidated: ADMIN_ALLOWLIST.airdrops,
      allowlists: []
    });
    jest.mocked(redisGet).mockClear();
  });

  it('serves durable preparation results to admins without HTTP response caching', async () => {
    await withServer(async (baseUrl) => {
      const first = await getAllowlist(baseUrl, ADMIN_WALLET);
      expect(first).toMatchObject({
        status: 200,
        cache: null,
        body: ADMIN_ALLOWLIST
      });

      const second = await getAllowlist(baseUrl, ADMIN_WALLET);
      expect(second).toMatchObject({
        status: 200,
        cache: null,
        body: ADMIN_ALLOWLIST
      });
      expect(mockPrepareDistributionPhase).toHaveBeenCalledTimes(2);
      expect(mockPrepareDistributionPhase).toHaveBeenCalledWith(
        CONTRACT,
        7,
        'allowlist-1',
        'public',
        '',
        expect.objectContaining({ timer: expect.anything() })
      );
      expect(redisGet).not.toHaveBeenCalled();
    });
  });

  it('rejects non-admins after an authorized preparation request', async () => {
    await withServer(async (baseUrl) => {
      await getAllowlist(baseUrl, ADMIN_WALLET);

      mockPrepareDistributionPhase.mockClear();
      jest.mocked(redisGet).mockClear();

      const response = await getAllowlist(baseUrl, NON_ADMIN_WALLET);

      // This route has always answered non-admins with 401 (not 403).
      expect(response.status).toBe(401);
      expect(response.cache).toBeNull();
      expect(response.body).toEqual({
        error: 'Only Subscription Admins can download allowlists'
      });
      // Unauthorized callers reach neither preparation nor response caching.
      expect(redisGet).not.toHaveBeenCalled();
      expect(mockPrepareDistributionPhase).not.toHaveBeenCalled();
    });
  });

  it('rejects non-admins for an entry seeded directly in the cache', async () => {
    mockCacheStore.set(
      cacheKey({ originalUrl: ALLOWLIST_PATH } as Request),
      JSON.stringify({
        __requestCache: true,
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify(ADMIN_ALLOWLIST)).toString('base64')
      })
    );

    await withServer(async (baseUrl) => {
      const nonAdmin = await getAllowlist(baseUrl, NON_ADMIN_WALLET);
      expect(nonAdmin.status).toBe(401);
      expect(nonAdmin.body).not.toMatchObject(ADMIN_ALLOWLIST);

      const admin = await getAllowlist(baseUrl, ADMIN_WALLET);
      expect(admin).toMatchObject({
        status: 200,
        cache: null,
        body: ADMIN_ALLOWLIST
      });
    });
  });

  it('rejects unauthenticated callers before touching the cache', async () => {
    await withServer(async (baseUrl) => {
      const response = await getAllowlist(baseUrl);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Needs authentication' });
      expect(redisGet).not.toHaveBeenCalled();
      expect(mockPrepareDistributionPhase).not.toHaveBeenCalled();
    });
  });
});
