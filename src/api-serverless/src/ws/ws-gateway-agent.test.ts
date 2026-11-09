const mockNodeHttpHandler = jest.fn();
jest.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: jest.fn((options: unknown) => {
    mockNodeHttpHandler(options);
    return {};
  })
}));

jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({})
  })),
  DeleteConnectionCommand: jest.fn(),
  PostToConnectionCommand: jest.fn()
}));

jest.mock('passport', () => ({ authenticate: jest.fn() }));

jest.mock('@/api/auth/auth-session-v2', () => ({
  isLegacyWsQueryTokenEnabled: jest.fn(() => false)
}));

jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: { getProfileIdByIdentityKey: jest.fn() }
}));

import { AppWebSockets } from '@/api/ws/ws';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';

describe('API Gateway client agent', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConcurrency = process.env.WS_FANOUT_CONCURRENCY;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalConcurrency === undefined) {
      delete process.env.WS_FANOUT_CONCURRENCY;
    } else {
      process.env.WS_FANOUT_CONCURRENCY = originalConcurrency;
    }
  });

  it('has a socket for every send the default fan-out keeps in flight', async () => {
    // Outside local development the gateway client is built on first use.
    process.env.NODE_ENV = 'test';
    delete process.env.WS_FANOUT_CONCURRENCY;
    const sockets = new AppWebSockets({
      deleteByConnectionId: jest.fn().mockResolvedValue(undefined)
    } as unknown as WsConnectionRepository);

    await sockets.deregister({ connectionId: 'connection-1' });

    expect(mockNodeHttpHandler).toHaveBeenCalledTimes(1);
    expect(mockNodeHttpHandler).toHaveBeenCalledWith(
      expect.objectContaining({ httpsAgent: { maxSockets: 50 } })
    );
  });
});
