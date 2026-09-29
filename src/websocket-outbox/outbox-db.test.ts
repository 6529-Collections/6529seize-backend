import { recordWebSocketEvent, withWebSocketMutation } from './outbox.db';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import { webSocketOutboxPartition } from './partition';

describe('transactional WebSocket capture', () => {
  const connection: ConnectionWrapper<unknown> = { connection: {} };
  const execute = jest.fn().mockResolvedValue([]);
  const transaction = jest.fn(async (work) => work(connection));
  const db = {
    execute,
    executeNativeQueriesInTransaction: transaction
  } as unknown as SqlExecutor;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });
  it('rejects capture outside the business transaction', async () => {
    await expect(
      recordWebSocketEvent({ type: 'identity', profileId: 'p' }, {}, db)
    ).rejects.toThrow('mutation transaction');
    expect(execute).not.toHaveBeenCalled();
  });
  it('reuses the caller transaction for the event insert', async () => {
    await withWebSocketMutation(db, { connection }, (ctx) =>
      recordWebSocketEvent({ type: 'identity', profileId: 'p' }, ctx, db)
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('insert into websocket_outbox'),
      expect.objectContaining({ event: '{"type":"identity","profileId":"p"}' }),
      { wrappedConnection: connection }
    );
  });
  it('opens one transaction when the mutation has none', async () => {
    await withWebSocketMutation(db, {}, async (ctx) => {
      await db.execute(
        'business mutation',
        {},
        { wrappedConnection: ctx.connection }
      );
      await recordWebSocketEvent({ type: 'identity', profileId: 'p' }, ctx, db);
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map((call) => call[2])).toEqual([
      { wrappedConnection: connection },
      { wrappedConnection: connection }
    ]);
  });
  it('propagates persistence failure so the caller cannot commit successfully', async () => {
    execute.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      withWebSocketMutation(db, {}, (ctx) =>
        recordWebSocketEvent({ type: 'identity', profileId: 'p' }, ctx, db)
      )
    ).rejects.toThrow('outbox unavailable');
  });
  it('keeps all frame types for one connection in one partition', () => {
    expect(
      webSocketOutboxPartition({
        type: 'delivery',
        connectionId: 'c',
        message: 'one'
      })
    ).toBe(
      webSocketOutboxPartition({
        type: 'delivery',
        connectionId: 'c',
        message: 'two'
      })
    );
    expect(
      webSocketOutboxPartition({
        type: 'drop',
        dropId: 'd',
        updateType: 'DROP_UPDATE'
      })
    ).toBe(
      webSocketOutboxPartition({
        type: 'drop-delete',
        dropId: 'd',
        waveId: 'w',
        serialNo: 1
      })
    );
  });
});

const originalNodeEnvironment = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnvironment;
});
