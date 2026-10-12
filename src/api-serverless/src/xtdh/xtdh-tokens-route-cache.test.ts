const mockCacheStore = new Map<string, string>();
const mockGetXTdhTokens = jest.fn();

jest.mock('@/redis', () => ({
  redisGet: jest.fn(async (key: string) => {
    const stored = mockCacheStore.get(key);
    return stored ? JSON.parse(stored) : null;
  }),
  redisSetJson: jest.fn(async (key: string, value: unknown) => {
    mockCacheStore.set(key, JSON.stringify(value));
  })
}));

jest.mock('@/api/auth/auth', () => ({
  // Mirrors passport's ['jwt', 'anonymous'] behaviour: "Bearer <wallet>" is a
  // valid credential, anything else is treated as anonymous.
  maybeAuthenticatedUser:
    () =>
    (
      req: { headers: Record<string, string>; user?: unknown },
      _res: unknown,
      next: () => void
    ) => {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      req.user = match ? { wallet: match[1] } : undefined;
      next();
    },
  getAuthenticationContext: async (req: { user?: { wallet: string } }) => ({
    authenticatedWallet: req.user?.wallet ?? null
  })
}));

jest.mock('@/api/xtdh/xtdh-info.service', () => ({
  xTdhInfoService: {
    getXTdhCollections: jest.fn(),
    getXTdhTokens: mockGetXTdhTokens,
    getXTdhContributors: jest.fn(),
    getXTdhGrantees: jest.fn()
  }
}));

jest.mock('@/api/xtdh/grants/xtdh-grants.routes', () => ({
  __esModule: true,
  default: jest.requireActual('express').Router()
}));

jest.mock('@/api/xtdh/stats/xtdh-stats.routes', () => ({
  __esModule: true,
  default: jest.requireActual('express').Router()
}));

import express from 'express';
import { Server } from 'node:http';
import router from '@/api/xtdh/xtdh.routes';

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express();
  app.use('/api/xtdh', router);
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function getTokens(baseUrl: string, authorization?: string) {
  const response = await fetch(`${baseUrl}/api/xtdh/tokens`, {
    headers: authorization ? { authorization } : {}
  });
  return {
    status: response.status,
    cache: response.headers.get('x-cache'),
    body: await response.json()
  };
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

describe('GET /xtdh/tokens caching', () => {
  beforeEach(() => {
    mockCacheStore.clear();
    mockGetXTdhTokens.mockReset();
    // The service output is viewer specific (subscribed_actions of owners).
    mockGetXTdhTokens.mockImplementation(
      async (
        _params: unknown,
        ctx: { authenticationContext: { authenticatedWallet: string | null } }
      ) => ({
        data: [],
        viewer: ctx.authenticationContext.authenticatedWallet
      })
    );
  });

  it('never serves one viewer a response that was cached for another', async () => {
    await withServer(async (baseUrl) => {
      const alice = await getTokens(baseUrl, 'Bearer alice');
      expect(alice).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: { viewer: 'alice' }
      });
      await waitForCacheEntries(1);

      const bob = await getTokens(baseUrl, 'Bearer bob');
      expect(bob).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: { viewer: 'bob' }
      });

      const anonymous = await getTokens(baseUrl);
      expect(anonymous).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: { viewer: null }
      });
      expect(mockGetXTdhTokens).toHaveBeenCalledTimes(3);
    });
  });

  it('still serves repeat requests from the same viewer from the cache', async () => {
    await withServer(async (baseUrl) => {
      await getTokens(baseUrl, 'Bearer alice');
      await waitForCacheEntries(1);

      const again = await getTokens(baseUrl, 'Bearer alice');
      expect(again).toMatchObject({
        status: 200,
        cache: 'HIT',
        body: { viewer: 'alice' }
      });
      expect(mockGetXTdhTokens).toHaveBeenCalledTimes(1);
    });
  });
});
