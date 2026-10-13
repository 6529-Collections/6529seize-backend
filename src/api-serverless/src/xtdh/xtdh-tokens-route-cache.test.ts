const mockCacheStore = new Map<string, string>();
const mockGetXTdhTokens = jest.fn();

jest.mock('passport', () => {
  const instance = new (jest.requireActual('passport').Passport)();
  return {
    __esModule: true,
    default: instance,
    authenticate: instance.authenticate.bind(instance)
  };
});

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
  maybeAuthenticatedUser:
    jest.requireActual('@/api/auth/auth').maybeAuthenticatedUser,
  getAuthenticationContext: async (req: {
    user?: { wallet: string; role?: string };
  }) => ({
    authenticatedWallet: req.user?.wallet.toLowerCase() ?? null,
    roleProfileId: req.user?.role ?? null
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
import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import { sign } from 'jsonwebtoken';
import router from '@/api/xtdh/xtdh.routes';

const JWT_SECRET = 'xtdh-cache-test-secret';
const TEST_TIME_SECONDS = 2_000_000_000;

function token(
  wallet: string,
  role?: string,
  expiresAt = TEST_TIME_SECONDS + 60
) {
  return `Bearer ${sign({ sub: wallet, role, exp: expiresAt }, JWT_SECRET, { algorithm: 'HS256' })}`;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express();
  app.use(passport.initialize());
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
    body: (await response.json()) as {
      viewer: string | null;
      role: string | null;
    }
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
  beforeAll(() => {
    passport.use(
      new JwtStrategy(
        {
          jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
          secretOrKey: JWT_SECRET,
          algorithms: ['HS256']
        },
        ({ sub: wallet, role, exp }, done) => done(null, { wallet, role, exp })
      )
    );
    passport.use(new AnonymousStrategy());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(TEST_TIME_SECONDS * 1000);
    mockCacheStore.clear();
    mockGetXTdhTokens.mockReset();
    // The service output is viewer specific (subscribed_actions of owners).
    mockGetXTdhTokens.mockImplementation(
      async (
        _params: unknown,
        ctx: {
          authenticationContext: {
            authenticatedWallet: string | null;
            roleProfileId: string | null;
          };
        }
      ) => ({
        data: [],
        viewer: ctx.authenticationContext.authenticatedWallet,
        role: ctx.authenticationContext.roleProfileId
      })
    );
  });

  it('never serves one viewer a response that was cached for another', async () => {
    await withServer(async (baseUrl) => {
      const alice = await getTokens(baseUrl, token('alice'));
      expect(alice).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: { viewer: 'alice' }
      });
      await waitForCacheEntries(1);

      const bob = await getTokens(baseUrl, token('bob'));
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
      const credential = token('alice');
      await getTokens(baseUrl, credential);
      await waitForCacheEntries(1);

      const again = await getTokens(baseUrl, credential);
      expect(again).toMatchObject({
        status: 200,
        cache: 'HIT',
        body: { viewer: 'alice' }
      });
      expect(mockGetXTdhTokens).toHaveBeenCalledTimes(1);
    });
  });

  it('never reuses a viewer response when the same JWT has expired', async () => {
    await withServer(async (baseUrl) => {
      const credential = token('alice', undefined, TEST_TIME_SECONDS + 1);
      expect((await getTokens(baseUrl, credential)).body.viewer).toBe('alice');
      await waitForCacheEntries(1);

      jest.spyOn(Date, 'now').mockReturnValue((TEST_TIME_SECONDS + 2) * 1000);
      const expired = await getTokens(baseUrl, credential);
      expect(expired).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: { viewer: null, role: null }
      });
      await waitForCacheEntries(2);
      expect((await getTokens(baseUrl)).cache).toBe('HIT');
      expect(
        (await getTokens(baseUrl, 'Bearer invalid')).body.viewer
      ).toBeNull();
      expect(mockGetXTdhTokens).toHaveBeenCalledTimes(2);
    });
  });

  it('shares entries for refreshed tokens but keeps proxy roles separate', async () => {
    await withServer(async (baseUrl) => {
      await getTokens(baseUrl, token('alice'));
      await waitForCacheEntries(1);
      expect(
        (
          await getTokens(
            baseUrl,
            token('ALICE', undefined, TEST_TIME_SECONDS + 120)
          )
        ).cache
      ).toBe('HIT');

      const proxy = await getTokens(baseUrl, token('alice', 'proxy-profile'));
      expect(proxy).toMatchObject({
        status: 200,
        cache: 'MISS',
        body: { viewer: 'alice', role: 'proxy-profile' }
      });
      await waitForCacheEntries(2);
      expect(
        (await getTokens(baseUrl, token('alice', 'another-proxy'))).cache
      ).toBe('MISS');
      expect(mockGetXTdhTokens).toHaveBeenCalledTimes(3);
    });
  });
});
