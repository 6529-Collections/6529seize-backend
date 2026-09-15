import type WebSocket from 'ws';
import { AppWebSockets } from '@/api/ws/ws';
import type { WsConnectionRepository } from '@/api/ws/ws-connection.repository';

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn()
    })
  }
}));

describe('unavailable local WebSocket transport', () => {
  const originalEnvironment = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'local';
  });
  afterAll(() => {
    process.env.NODE_ENV = originalEnvironment;
  });

  async function fixture() {
    const order: string[] = [];
    const close = jest.fn(() => {
      order.push('close');
    });
    const repository = {
      save: jest.fn(async () => undefined),
      maybeCleanupStaleNotificationSubscriptions: jest.fn(
        async () => undefined
      ),
      deleteByConnectionId: jest.fn(async () => {
        order.push('cleanup');
      })
    };
    const sockets = new AppWebSockets(
      repository as unknown as WsConnectionRepository
    );
    await sockets.register({
      identityId: 'synthetic-profile',
      connectionId: 'synthetic-local-socket',
      jwtExpiry: 2000000000,
      ws: { send: jest.fn(), close } as unknown as WebSocket
    });
    repository.save.mockClear();
    return { sockets, repository, close, order };
  }

  it('calls the actual local socket close before cleanup without re-registering state', async () => {
    const { sockets, repository, close, order } = await fixture();
    await sockets.closeUnavailableConnection('synthetic-local-socket');
    expect(order).toEqual(['close', 'cleanup']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.deleteByConnectionId).toHaveBeenCalledWith(
      'synthetic-local-socket',
      {}
    );
  });

  it('propagates close failure and retains the transport for a later attempt', async () => {
    const { sockets, repository, close } = await fixture();
    const failure = new Error('synthetic close failure');
    close.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      sockets.closeUnavailableConnection('synthetic-local-socket')
    ).rejects.toBe(failure);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    await expect(
      sockets.closeUnavailableConnection('synthetic-local-socket')
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(repository.deleteByConnectionId).toHaveBeenCalledTimes(1);
  });

  it('still removes orphan state when the local transport has already disappeared', async () => {
    const { sockets, repository, close } = await fixture();
    await sockets.closeUnavailableConnection('synthetic-local-socket');
    repository.deleteByConnectionId.mockClear();
    await sockets.closeUnavailableConnection('synthetic-local-socket');
    expect(close).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).toHaveBeenCalledTimes(1);
  });
});
