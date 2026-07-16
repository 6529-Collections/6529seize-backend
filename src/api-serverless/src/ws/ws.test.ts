const mockPassportAuthenticate = jest.fn();

jest.mock('passport', () => ({
  authenticate: (...args: unknown[]) => mockPassportAuthenticate(...args)
}));

jest.mock('@/api/auth/auth-session-v2', () => ({
  isLegacyWsQueryTokenEnabled: jest.fn(() => false)
}));

jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: jest.fn()
  }
}));

import { identityFetcher } from '@/api/identities/identity.fetcher';
import {
  wsConnectionRepository,
  WsConnectionRepository
} from '@/api/ws/ws-connection.repository';
import {
  ANON_USER_ID,
  appWebSockets,
  AppWebSockets,
  authenticateNotificationIdentityTokens,
  authenticateWebSocketJwtOrGetByConnectionId,
  authenticateWebSocketToken
} from '@/api/ws/ws';
import WebSocket from 'ws';

const identityFetcherMock = identityFetcher as jest.Mocked<
  typeof identityFetcher
>;

describe('authenticateWebSocketToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPassportAuthenticate.mockImplementation(
      (_strategy, _options, callback) => (_req: unknown, _res: unknown) =>
        callback(null, { wallet: '0xabc', exp: 1234 })
    );
  });

  it('resolves null when identity lookup rejects', async () => {
    identityFetcherMock.getProfileIdByIdentityKey.mockRejectedValueOnce(
      new Error('db unavailable')
    );

    await expect(authenticateWebSocketToken('valid-token')).resolves.toBeNull();
  });

  it('resolves null when JWT exp is missing', async () => {
    mockPassportAuthenticate.mockImplementation(
      (_strategy, _options, callback) => (_req: unknown, _res: unknown) =>
        callback(null, { wallet: '0xabc' })
    );

    await expect(authenticateWebSocketToken('missing-exp')).resolves.toBeNull();
    expect(
      identityFetcherMock.getProfileIdByIdentityKey
    ).not.toHaveBeenCalled();
  });
});

describe('authenticateNotificationIdentityTokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPassportAuthenticate.mockImplementation(
      (_strategy, _options, callback) => (req: any, _res: unknown) => {
        const token = req.headers.authorization.replace('Bearer ', '');
        callback(null, { wallet: token, exp: 2_000_000_000 });
      }
    );
    identityFetcherMock.getProfileIdByIdentityKey.mockImplementation(
      async ({ identityKey }) => `profile-${identityKey}`
    );
  });

  it('authenticates and deduplicates notification identity tokens', async () => {
    await expect(
      authenticateNotificationIdentityTokens(['wallet-1', 'wallet-1'])
    ).resolves.toEqual([
      { identityId: 'profile-wallet-1', jwtExpiry: 2_000_000_000 }
    ]);
  });

  it('rejects more than five notification identity tokens', async () => {
    await expect(
      authenticateNotificationIdentityTokens(['1', '2', '3', '4', '5', '6'])
    ).resolves.toBeNull();
    expect(mockPassportAuthenticate).not.toHaveBeenCalled();
  });

  it('applies the notification token cap after exact-token deduplication', async () => {
    await expect(
      authenticateNotificationIdentityTokens(Array(6).fill('wallet-1'))
    ).resolves.toEqual([
      { identityId: 'profile-wallet-1', jwtExpiry: 2_000_000_000 }
    ]);
    expect(mockPassportAuthenticate).toHaveBeenCalledTimes(1);
  });
});

describe('authenticateWebSocketJwtOrGetByConnectionId', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects expired stored websocket auth and deregisters the connection', async () => {
    jest.spyOn(wsConnectionRepository, 'getByConnectionId').mockResolvedValue({
      connection_id: 'connection-expired',
      identity_id: 'identity-1',
      jwt_expiry: Math.floor(Date.now() / 1000) - 60,
      wave_id: null
    });
    const deregisterSpy = jest
      .spyOn(appWebSockets, 'deregister')
      .mockResolvedValue(undefined);

    const result = await authenticateWebSocketJwtOrGetByConnectionId({
      headers: {},
      requestContext: {
        connectionId: 'connection-expired'
      }
    } as any);

    expect(result.identityId).toBe(ANON_USER_ID);
    expect(deregisterSpy).toHaveBeenCalledWith({
      connectionId: 'connection-expired'
    });
  });
});

describe('AppWebSockets notification subscription maintenance', () => {
  it('samples stale cleanup after identity authentication and resync', async () => {
    const repository = {
      updateIdentityForConnection: jest.fn().mockResolvedValue(undefined),
      replaceNotificationSubscriptions: jest.fn().mockResolvedValue(undefined),
      maybeCleanupStaleNotificationSubscriptions: jest
        .fn()
        .mockResolvedValue(undefined)
    };
    const sockets = new AppWebSockets(
      repository as unknown as WsConnectionRepository
    );

    await sockets.authenticateConnection(
      {
        connectionId: 'connection-1',
        identityId: 'profile-1',
        jwtExpiry: 123
      },
      {}
    );
    await sockets.syncNotificationIdentities(
      'connection-1',
      [{ identityId: 'profile-2', jwtExpiry: 456 }],
      {}
    );

    expect(
      repository.maybeCleanupStaleNotificationSubscriptions
    ).toHaveBeenCalledTimes(2);
  });
});

describe('AppWebSockets.send', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('can send protocol failure frames without the stale expiry lookup', async () => {
    process.env.NODE_ENV = 'local';
    const connectionId = 'connection-auth-failure';
    const repository = {
      save: jest.fn().mockResolvedValue(undefined),
      replaceNotificationSubscriptions: jest.fn().mockResolvedValue(undefined),
      maybeCleanupStaleNotificationSubscriptions: jest
        .fn()
        .mockResolvedValue(undefined),
      getByConnectionId: jest.fn(),
      deleteByConnectionId: jest.fn().mockResolvedValue(undefined)
    };
    const socket = {
      send: jest.fn(),
      close: jest.fn()
    };
    const appWebSockets = new AppWebSockets(
      repository as unknown as WsConnectionRepository
    );

    await appWebSockets.register({
      identityId: 'identity-1',
      connectionId,
      jwtExpiry: 1,
      ws: socket as unknown as WebSocket
    });
    repository.getByConnectionId.mockClear();

    await appWebSockets.send({
      connectionId,
      message: 'AUTHENTICATION_FAILED',
      skipStaleConnectionCheck: true
    });

    expect(repository.getByConnectionId).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith('AUTHENTICATION_FAILED');
  });
});
