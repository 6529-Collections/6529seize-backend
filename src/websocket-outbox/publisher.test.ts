jest.mock('./resolve', () => ({ resolveWebSocketEvent: jest.fn() }));
import { publishWebSocketOutbox } from './publisher';
import { resolveWebSocketEvent } from './resolve';
import { SqlExecutor } from '@/sql-executor';

const frame = {
  type: 'delivery' as const,
  connectionId: 'c',
  message: 'frame'
};
function database(rows: object[]) {
  const execute = jest.fn().mockResolvedValue([]);
  const bulkInsert = jest.fn().mockResolvedValue(undefined);
  const oneOrNull = jest.fn(async () => rows.shift() ?? null);
  const transaction = jest.fn(async (work) => work({ connection: {} }));
  return {
    execute,
    bulkInsert,
    oneOrNull,
    executeNativeQueriesInTransaction: transaction
  };
}
const pending = (event = frame) => ({
  id: 1,
  event,
  created_at: 1,
  attempts: 0
});
describe('WebSocket outbox publication', () => {
  beforeEach(() => jest.clearAllMocks());
  it('keeps rejected SQS publication and schedules a retry', async () => {
    const db = database([pending()]);
    const send = jest.fn().mockRejectedValue(new Error('SQS unavailable'));
    expect(
      await publishWebSocketOutbox(send, db as unknown as SqlExecutor)
    ).toBe(0);
    expect(
      db.execute.mock.calls.some(([sql]) => sql.startsWith('delete'))
    ).toBe(false);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('attempts = attempts + 1'),
      expect.objectContaining({ id: 1 }),
      expect.anything()
    );
  });
  it('deletes only after SQS accepts the recipient job', async () => {
    const db = database([pending()]);
    const send = jest.fn().mockResolvedValue(undefined);
    expect(
      await publishWebSocketOutbox(send, db as unknown as SqlExecutor)
    ).toBe(1);
    expect(send).toHaveBeenCalledWith(frame, '1');
    const deletion = db.execute.mock.calls.findIndex(([sql]) =>
      sql.startsWith('delete')
    );
    expect(db.execute.mock.invocationCallOrder[deletion]).toBeGreaterThan(
      send.mock.invocationCallOrder[0]!
    );
  });
  it('materializes fan-out atomically before acknowledging its domain event', async () => {
    const db = database([
      { ...pending(), event: { type: 'identity', profileId: 'p' } }
    ]);
    jest
      .mocked(resolveWebSocketEvent)
      .mockResolvedValue([frame, { ...frame, connectionId: 'other' }]);
    const send = jest.fn();
    await publishWebSocketOutbox(send, db as unknown as SqlExecutor);
    expect(send).not.toHaveBeenCalled();
    expect(db.bulkInsert).toHaveBeenCalledWith(
      'websocket_outbox',
      expect.arrayContaining([
        expect.objectContaining({ created_at: 1, event: JSON.stringify(frame) })
      ]),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });
  it('rolls back partial fan-out materialization before retaining the parent', async () => {
    const db = database([
      { ...pending(), event: { type: 'identity', profileId: 'p' } }
    ]);
    jest.mocked(resolveWebSocketEvent).mockResolvedValue([frame]);
    db.bulkInsert.mockRejectedValueOnce(new Error('second chunk failed'));
    await publishWebSocketOutbox(jest.fn(), db as unknown as SqlExecutor);
    expect(db.execute).toHaveBeenCalledWith(
      'ROLLBACK TO SAVEPOINT ws_outbox_publish',
      {},
      expect.anything()
    );
    expect(
      db.execute.mock.calls.some(([sql]) => sql.startsWith('delete'))
    ).toBe(false);
  });
  it('does not start work after the invocation budget is exhausted', async () => {
    const db = database([pending()]);
    await publishWebSocketOutbox(
      jest.fn(),
      db as unknown as SqlExecutor,
      () => false
    );
    expect(db.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });
  it('waits for other in-flight workers when a transaction fails', async () => {
    const db = database([pending(), { ...pending(), id: 2 }]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.executeNativeQueriesInTransaction.mockImplementationOnce(async () => {
      throw new Error('transaction lost');
    });
    const send = jest.fn(async () => held);
    let settled = false;
    const run = publishWebSocketOutbox(
      send,
      db as unknown as SqlExecutor
    ).catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await run).message).toBe('transaction lost');
  });
});

it('bounds a large backlog per invocation and limits in-flight publication', async () => {
  const db = database(
    Array.from({ length: 1000 }, (_, index) => ({
      ...pending(),
      id: index + 1
    }))
  );
  let active = 0;
  let maximum = 0;
  const send = jest.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
  });
  expect(await publishWebSocketOutbox(send, db as unknown as SqlExecutor)).toBe(
    100
  );
  expect(send).toHaveBeenCalledTimes(100);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
});
