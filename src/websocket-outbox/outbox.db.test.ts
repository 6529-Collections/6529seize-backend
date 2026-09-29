jest.mock('./resolve', () => ({ resolveWebSocketEvent: jest.fn() }));
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ReactionsDb } from '@/api/drops/reactions.db';
import { DROP_REACTIONS_TABLE, WEBSOCKET_OUTBOX_TABLE } from '@/constants';
import { recordWebSocketEvent } from './outbox.db';
import { publishWebSocketOutbox } from './publisher';
import { resolveWebSocketEvent } from './resolve';

const frame = {
  type: 'delivery' as const,
  connectionId: 'connection-one',
  message: 'frame'
};
const rows = () =>
  sqlExecutor.execute(`select * from ${WEBSOCKET_OUTBOX_TABLE} order by id`);

describeWithSeed('WebSocket outbox MySQL transaction boundary', [], () => {
  const reactions = new ReactionsDb(() => sqlExecutor);
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    process.env.NODE_ENV = 'local';
  });
  it('rolls back the real reaction and its event together', async () => {
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        await reactions.addReaction('p', 'd', 'w', ':+1:', { connection });
        expect(
          await sqlExecutor.execute(
            `select * from ${WEBSOCKET_OUTBOX_TABLE}`,
            {},
            { wrappedConnection: connection }
          )
        ).toHaveLength(1);
        throw new Error('business failure after capture');
      })
    ).rejects.toThrow('business failure');
    expect(await rows()).toEqual([]);
    expect(
      await sqlExecutor.execute(`select * from ${DROP_REACTIONS_TABLE}`)
    ).toEqual([]);
  });
  it('survives a missed wakeup and retries SQS after committing the business mutation', async () => {
    await reactions.addReaction('p', 'd', 'w', ':+1:', {});
    expect(await rows()).toHaveLength(1);
    jest.mocked(resolveWebSocketEvent).mockResolvedValue([frame]);
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('forced SQS rejection'))
      .mockResolvedValue(undefined);
    await publishWebSocketOutbox(send, sqlExecutor);
    const retained = await rows();
    expect(retained).toHaveLength(1);
    expect(retained[0].attempts).toBe(1);
    await sqlExecutor.execute(
      `update ${WEBSOCKET_OUTBOX_TABLE} set available_at = 0`
    );
    await publishWebSocketOutbox(send, sqlExecutor);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await rows()).toEqual([]);
    expect(
      await sqlExecutor.execute(`select * from ${DROP_REACTIONS_TABLE}`)
    ).toHaveLength(1);
  });
  it('holds later frames behind a deferred head without blocking other connections', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await recordWebSocketEvent(frame, { connection }, sqlExecutor);
      await recordWebSocketEvent(
        { ...frame, message: 'second' },
        { connection },
        sqlExecutor
      );
      await recordWebSocketEvent(
        { ...frame, connectionId: 'other', message: 'independent' },
        { connection },
        sqlExecutor
      );
    });
    const pending = await rows();
    await sqlExecutor.execute(
      `update ${WEBSOCKET_OUTBOX_TABLE} set available_at = :later where id = :id`,
      { later: Date.now() + 60_000, id: pending[0].id }
    );
    const send = jest.fn().mockResolvedValue(undefined);
    await publishWebSocketOutbox(send, sqlExecutor);
    expect(send.mock.calls.map(([event]) => event.message)).toEqual([
      'independent'
    ]);
    await sqlExecutor.execute(
      `update ${WEBSOCKET_OUTBOX_TABLE} set available_at = 0`
    );
    await publishWebSocketOutbox(send, sqlExecutor);
    expect(send.mock.calls.map(([event]) => event.message)).toEqual([
      'independent',
      'frame',
      'second'
    ]);
  });
});
