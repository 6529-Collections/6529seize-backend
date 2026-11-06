import { AppWebSockets } from '@/api/ws/ws';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Waves 1.2: fan-outs hand the JWT expiry from their recipient query to the
 * send, so the "never deliver after a JWT expires" fence costs no MySQL read
 * per recipient. These cases pin the fence on every path.
 */
describe('AppWebSockets.send JWT fence', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'local';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  async function connected(storedJwtExpiry: number | null) {
    const repository = {
      save: jest.fn().mockResolvedValue(undefined),
      maybeCleanupStaleNotificationSubscriptions: jest
        .fn()
        .mockResolvedValue(undefined),
      getByConnectionId: jest
        .fn()
        .mockResolvedValue(
          storedJwtExpiry === null ? null : { jwt_expiry: storedJwtExpiry }
        ),
      deleteByConnectionId: jest.fn().mockResolvedValue(undefined)
    };
    const socket = { send: jest.fn(), close: jest.fn() };
    const sockets = new AppWebSockets(
      repository as unknown as WsConnectionRepository
    );
    await sockets.register({
      identityId: 'identity-1',
      connectionId: 'connection-1',
      jwtExpiry: nowSeconds() + 3600,
      ws: socket as never
    });
    return { sockets, repository, socket };
  }

  it('sends without reading MySQL when the known expiry is in the future', async () => {
    const { sockets, repository, socket } = await connected(null);
    const reads = jest.fn();

    await expect(
      sockets.send({
        connectionId: 'connection-1',
        message: '{"type":"DROP_UPDATE"}',
        jwtExpiry: nowSeconds() + 60,
        onConnectionRead: reads
      })
    ).resolves.toEqual({ status: 'sent' });

    expect(repository.getByConnectionId).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith('{"type":"DROP_UPDATE"}');
  });

  it.each([
    ['as a number', nowSeconds() + 60],
    ['as a MySQL BIGINT string', String(nowSeconds() + 60)]
  ])('accepts a known expiry %s', async (_label, jwtExpiry) => {
    const { sockets, repository } = await connected(null);
    await expect(
      sockets.send({ connectionId: 'connection-1', message: '{}', jwtExpiry })
    ).resolves.toEqual({ status: 'sent' });
    expect(repository.getByConnectionId).not.toHaveBeenCalled();
  });

  it('never delivers after the JWT expired and the stored row agrees', async () => {
    const { sockets, repository, socket } = await connected(nowSeconds() - 1);
    const reads = jest.fn();

    await expect(
      sockets.send({
        connectionId: 'connection-1',
        message: '{"type":"DROP_UPDATE"}',
        jwtExpiry: nowSeconds() - 1,
        onConnectionRead: reads
      })
    ).resolves.toEqual({ status: 'gone' });

    expect(reads).toHaveBeenCalledTimes(1);
    expect(repository.getByConnectionId).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).toHaveBeenCalledWith(
      'connection-1',
      {}
    );
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
  });

  it('does not close a socket that reauthenticated after the recipient query', async () => {
    const { sockets, repository, socket } = await connected(
      nowSeconds() + 3600
    );

    await expect(
      sockets.send({
        connectionId: 'connection-1',
        message: '{"type":"DROP_UPDATE"}',
        jwtExpiry: nowSeconds() - 1
      })
    ).resolves.toEqual({ status: 'sent' });

    expect(repository.getByConnectionId).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, 'not-a-number', null])(
    'falls back to the stored row for an unusable known expiry (%p)',
    async (jwtExpiry) => {
      const { sockets, repository } = await connected(nowSeconds() + 60);
      await expect(
        sockets.send({ connectionId: 'connection-1', message: '{}', jwtExpiry })
      ).resolves.toEqual({ status: 'sent' });
      expect(repository.getByConnectionId).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps the legacy read when no expiry is supplied', async () => {
    const { sockets, repository } = await connected(null);
    await expect(
      sockets.send({ connectionId: 'connection-1', message: '{}' })
    ).resolves.toEqual({ status: 'gone' });
    expect(repository.getByConnectionId).toHaveBeenCalledTimes(1);
  });
});
