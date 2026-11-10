const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const getRedisClientMock = jest.fn();
const redeemConnectionShareMock = jest.fn();

jest.mock('../async.router', () => ({
  asyncRouter: () => ({
    get: mockRouterGet,
    post: mockRouterPost
  })
}));

jest.mock('@/redis', () => ({
  getRedisClient: () => getRedisClientMock()
}));

jest.mock('./auth', () => ({
  getAuthenticatedWalletOrNull: jest.fn(),
  getJwtSecret: () => 'auth-routes-connection-share-redeem-test-secret',
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('./auth-session-v2', () => ({
  createConnectionShare: jest.fn(),
  createNativeSession: jest.fn(),
  createWebSession: jest.fn(),
  hasActiveNativeSessionForAddressAndRole: jest.fn(),
  hasActiveWebSessionForAddressAndRole: jest.fn(),
  isAuthConnectionSharingEnabled: jest.fn().mockReturnValue(true),
  issueAccessToken: jest.fn(),
  logoutNativeSession: jest.fn(),
  logoutWebSession: jest.fn(),
  redeemConnectionShare: redeemConnectionShareMock,
  refreshNativeSession: jest.fn(),
  refreshWebSessionForAddress: jest.fn()
}));

jest.mock('./auth.db', () => ({
  authDb: {
    retrieveOrGenerateRefreshToken: jest.fn(),
    redeemRefreshToken: jest.fn()
  }
}));

jest.mock('./auth-legacy-refresh', () => ({
  assertLegacyRefreshEnabled: jest.fn()
}));

jest.mock('../identities/identity.fetcher', () => ({
  identityFetcher: { getProfileIdByIdentityKey: jest.fn() }
}));

jest.mock('../proxies/proxy.api.service', () => ({
  profileProxyApiService: { getProxyByGrantedByAndGrantedTo: jest.fn() }
}));

import { CONNECTION_SHARE_REDEEM_FAILURE_LIMIT } from './connection-share-redeem-guard';
import './auth.routes';

const redeemHandler = getRouteHandler(
  mockRouterPost,
  '/connection-share/redeem'
);
const VALID_CODE = 'a'.repeat(64);
const UNKNOWN_CODE = 'b'.repeat(64);
const REDEEMED = {
  response: {
    address: '0xabc',
    role: null,
    encrypted_device_setup: 'v1.setup',
    access_token: 'access',
    access_token_expires_at: new Date(),
    client_type: 'native',
    native_refresh_token: 'refresh',
    refresh_token_expires_at: new Date()
  }
};

function fakeRedis() {
  const counters = new Map<string, number>();
  return {
    get: jest.fn(async (key: string) => counters.get(key)?.toString() ?? null),
    multi: jest.fn(() => {
      let key = '';
      const chain = {
        set: (setKey: string) => {
          key = setKey;
          return chain;
        },
        incr: () => chain,
        exec: async () => {
          counters.set(key, (counters.get(key) ?? 0) + 1);
          return ['OK', counters.get(key)];
        }
      };
      return chain;
    })
  };
}

describe('POST /auth/connection-share/redeem', () => {
  let stdoutWrite: jest.SpyInstance;

  beforeEach(() => {
    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    getRedisClientMock.mockReturnValue(fakeRedis());
    redeemConnectionShareMock.mockImplementation(
      async ({ connectionShareCode }) =>
        connectionShareCode === VALID_CODE ? REDEEMED : null
    );
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    jest.clearAllMocks();
  });

  function redeemMetrics(): Record<string, unknown>[] {
    return stdoutWrite.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('6529.connection_share_redeem.v1'))
      .map((line) => JSON.parse(line));
  }

  it('redeems a link exactly as current clients send it', async () => {
    const res = makeResponse();

    await redeemHandler(redeemRequest(VALID_CODE, '203.0.113.7'), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.send).toHaveBeenCalledWith(REDEEMED.response);
    expect(redeemConnectionShareMock).toHaveBeenCalledWith({
      connectionShareCode: VALID_CODE,
      targetClientType: 'native',
      userAgent: 'Capacitor'
    });
    expect(redeemMetrics()).toEqual([
      expect.objectContaining({
        Target: 'native',
        Outcome: 'ok',
        DeviceSetup: 'yes'
      })
    ]);
  });

  it('answers 429 to a source after too many invalid codes, without trying the code', async () => {
    for (let i = 0; i < CONNECTION_SHARE_REDEEM_FAILURE_LIMIT; i++) {
      await expect(
        redeemHandler(
          redeemRequest(UNKNOWN_CODE, '203.0.113.7'),
          makeResponse()
        )
      ).rejects.toThrow('Invalid connection share code');
    }
    redeemConnectionShareMock.mockClear();

    const limited = redeemHandler(
      redeemRequest(VALID_CODE, '203.0.113.7'),
      makeResponse()
    );
    await expect(limited).rejects.toThrow(
      'Too many invalid connection share codes'
    );
    await limited.catch((error: { getStatusCode?: () => number }) => {
      expect(error.getStatusCode?.()).toBe(429);
    });
    expect(redeemConnectionShareMock).not.toHaveBeenCalled();

    await expect(
      redeemHandler(redeemRequest(VALID_CODE, '203.0.113.8'), makeResponse())
    ).resolves.toBeUndefined();
    expect(redeemMetrics().map((metric) => metric.Outcome)).toEqual([
      ...new Array(CONNECTION_SHARE_REDEEM_FAILURE_LIMIT).fill('refused'),
      'limited',
      'ok'
    ]);
  });

  it('does not limit without Redis', async () => {
    getRedisClientMock.mockReturnValue(null);
    for (let i = 0; i <= CONNECTION_SHARE_REDEEM_FAILURE_LIMIT; i++) {
      await expect(
        redeemHandler(
          redeemRequest(UNKNOWN_CODE, '203.0.113.7'),
          makeResponse()
        )
      ).rejects.toThrow('Invalid connection share code');
    }

    await expect(
      redeemHandler(redeemRequest(VALID_CODE, '203.0.113.7'), makeResponse())
    ).resolves.toBeUndefined();
  });
});

function redeemRequest(code: string, sourceIp: string) {
  return {
    body: { connection_share_code: code, target_client_type: 'native' },
    headers: { 'user-agent': 'Capacitor' },
    requestContext: { identity: { sourceIp } },
    timer: undefined
  };
}

function makeResponse() {
  const response = {
    setHeader: jest.fn(),
    send: jest.fn(),
    status: jest.fn()
  };
  response.status.mockReturnValue(response);
  return response;
}

function getRouteHandler(
  mockRouterMethod: jest.Mock,
  path: string
): (...args: any[]) => any {
  const registration = mockRouterMethod.mock.calls.find(
    ([registeredPath]) => registeredPath === path
  );
  if (!registration) {
    throw new Error(`Route ${path} was not registered`);
  }
  return registration.at(-1);
}
