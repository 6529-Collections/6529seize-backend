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
  let reactions: ReactionsDb;
  beforeEach(() => {
    // The shared test hook replaces the executor for each test; repositories cache it.
    reactions = new ReactionsDb(() => sqlExecutor);
    process.env.NODE_ENV = 'test';
    jest.mocked(resolveWebSocketEvent).mockReset();
  });
  afterEach(() => {
    process.env.NODE_ENV = 'local';
    jest.restoreAllMocks();
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
  it.each([false, true])(
    'rolls back the real business write on capture failure (existing=%s)',
    async (existing) => {
      const execute = sqlExecutor.execute.bind(sqlExecutor);
      const transaction = jest.spyOn(
        sqlExecutor,
        'executeNativeQueriesInTransaction'
      );
      const captureFailure = jest.fn(() =>
        Promise.reject(new Error('forced outbox insert failure'))
      );
      jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation((sql, params, options) => {
          if (sql.includes(`insert into ${WEBSOCKET_OUTBOX_TABLE}`))
            return captureFailure();
          return execute(sql, params, options);
        });
      const mutation = existing
        ? sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            reactions.addReaction('p', 'd', 'w', 'like', { connection })
          )
        : reactions.addReaction('p', 'd', 'w', 'like', {});
      await expect(mutation).rejects.toThrow('forced outbox insert failure');
      expect(captureFailure).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual([]);
      expect(
        await sqlExecutor.execute(`select * from ${DROP_REACTIONS_TABLE}`)
      ).toEqual([]);
    }
  );

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
  it.each(['resolver', 'partial-insert'])(
    'releases the parent for replay after %s failure',
    async (failure) => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        recordWebSocketEvent(
          { type: 'identity', profileId: 'p' },
          { connection },
          sqlExecutor
        )
      );
      jest.mocked(resolveWebSocketEvent).mockResolvedValue([frame]);
      if (failure === 'resolver') {
        jest
          .mocked(resolveWebSocketEvent)
          .mockRejectedValueOnce(new Error('resolver unavailable'));
      } else {
        jest
          .spyOn(sqlExecutor, 'bulkInsert')
          .mockImplementationOnce(async (_table, _rows, _columns, ctx) => {
            if (!ctx) throw new Error('Expected transaction context');
            // A successful first chunk must disappear if the next chunk fails.
            await recordWebSocketEvent(frame, ctx, sqlExecutor);
            throw new Error('later chunk failed');
          });
      }
      const send = jest.fn().mockResolvedValue(undefined);
      await publishWebSocketOutbox(send, sqlExecutor);
      const retained = await rows();
      expect(retained).toHaveLength(1);
      expect(retained[0].attempts).toBe(1);
      expect(send).not.toHaveBeenCalled();
      // An independent transaction can acquire the row immediately: no leaked lock.
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `select id from ${WEBSOCKET_OUTBOX_TABLE} for update nowait`,
            {},
            { wrappedConnection: connection }
          );
          await sqlExecutor.execute(
            `update ${WEBSOCKET_OUTBOX_TABLE} set available_at = 0`,
            {},
            { wrappedConnection: connection }
          );
        }
      );
      await publishWebSocketOutbox(send, sqlExecutor);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual([]);
    }
  );

  it('materializes a resource only once while another drain races its locked row', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      recordWebSocketEvent(
        { type: 'identity', profileId: 'p' },
        { connection },
        sqlExecutor
      )
    );
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.mocked(resolveWebSocketEvent).mockClear();
    jest.mocked(resolveWebSocketEvent).mockImplementationOnce(async () => {
      entered();
      await held;
      return [frame];
    });
    const send = jest.fn().mockResolvedValue(undefined);
    const first = publishWebSocketOutbox(send, sqlExecutor);
    try {
      await resolving;
      // This separate drain must skip the resource held by the first transaction.
      await expect(publishWebSocketOutbox(send, sqlExecutor)).resolves.toBe(0);
      expect(resolveWebSocketEvent).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      release();
      await first;
    }
    expect(resolveWebSocketEvent).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
  });

  it('captures exactly one real MySQL reaction overwrite and no same-value repost', async () => {
    await reactions.addReaction('p', 'd', 'w', 'like', {});
    await sqlExecutor.execute(`delete from ${WEBSOCKET_OUTBOX_TABLE}`);
    await expect(
      reactions.addReaction('p', 'd', 'w', 'love', {})
    ).resolves.toBe(true);
    const overwritten = await rows();
    expect(overwritten).toHaveLength(1);
    const event = overwritten[0].event;
    expect(typeof event === 'string' ? JSON.parse(event) : event).toEqual({
      type: 'drop',
      dropId: 'd',
      updateType: 'DROP_REACTION_UPDATE',
      deliveryCapability: 'durable_updates_v1'
    });
    await expect(
      reactions.addReaction('p', 'd', 'w', 'love', {})
    ).resolves.toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it('holds two same-resource updates behind the deferred recipient head', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await recordWebSocketEvent(
        { type: 'drop', dropId: 'd', updateType: 'DROP_REACTION_UPDATE' },
        { connection },
        sqlExecutor
      );
      await recordWebSocketEvent(
        { type: 'drop', dropId: 'd', updateType: 'DROP_REACTION_UPDATE' },
        { connection },
        sqlExecutor
      );
    });
    let claims = 0;
    jest
      .mocked(resolveWebSocketEvent)
      .mockResolvedValueOnce([{ ...frame, message: 'first' }])
      .mockResolvedValueOnce([{ ...frame, message: 'second' }]);
    const send = jest.fn().mockResolvedValue(undefined);
    // Allow one initial claim so the first recipient can be deferred before another drain.
    await publishWebSocketOutbox(send, sqlExecutor, () => claims++ === 0);
    const firstRecipient = (await rows()).find((row) => {
      const event =
        typeof row.event === 'string' ? JSON.parse(row.event) : row.event;
      return event.type === 'delivery';
    });
    expect(firstRecipient).toBeDefined();
    await sqlExecutor.execute(
      `update ${WEBSOCKET_OUTBOX_TABLE} set available_at = :later where id = :id`,
      { later: Date.now() + 60_000, id: firstRecipient.id }
    );
    await publishWebSocketOutbox(send, sqlExecutor);
    expect(send).not.toHaveBeenCalled();
    expect(resolveWebSocketEvent).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(2);
    await sqlExecutor.execute(
      `update ${WEBSOCKET_OUTBOX_TABLE} set available_at = 0`
    );
    await publishWebSocketOutbox(send, sqlExecutor);
    expect(send.mock.calls.map(([event]) => event.message)).toEqual([
      'first',
      'second'
    ]);
    expect(await rows()).toEqual([]);
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
