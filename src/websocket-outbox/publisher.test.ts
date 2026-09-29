jest.mock('@/logging', () => {
  const logger = { error: jest.fn() };
  return { Logger: { get: () => logger } };
});
import { Logger } from '@/logging';
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
  it.each([
    [new TypeError('private payload'), 'TypeError'],
    [new ReferenceError('private payload'), 'ReferenceError'],
    [new SyntaxError('private payload'), 'SyntaxError'],
    [new RangeError('private payload'), 'RangeError'],
    [new Error('private payload'), 'Error'],
    ['private payload', 'Unknown'],
    [
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('private payload');
          }
        }
      ),
      'Unknown'
    ]
  ])('logs safe failure diagnostics for %s', async (error, errorClass) => {
    const db = database([pending()]);
    await publishWebSocketOutbox(
      jest.fn().mockRejectedValue(error),
      db as unknown as SqlExecutor
    );
    const log = jest.mocked(Logger.get('WEBSOCKET_OUTBOX').error);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'WS_OUTBOX_PUBLISH_FAILED',
        phase: 'enqueue',
        error_class: errorClass
      })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private payload');
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
  it.each([
    [0, 1000],
    [5, 32000],
    [6, 60000],
    [100, 60000]
  ])('backs off attempt %i by %i milliseconds', async (attempts, delay) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
    try {
      const db = database([{ ...pending(), attempts }]);
      await publishWebSocketOutbox(
        jest.fn().mockRejectedValue(new Error('unavailable')),
        db as unknown as SqlExecutor
      );
      expect(db.execute).toHaveBeenCalledWith(
        expect.stringContaining('available_at = :next'),
        { id: 1, next: 100000 + delay },
        expect.anything()
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('stops new jobs at the deadline but awaits accepted in-flight jobs', async () => {
    const db = database(
      Array.from({ length: 8 }, (_, id) => ({ ...pending(), id }))
    );
    let budget = true;
    let release!: () => void;
    let started!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const send = jest.fn(async () => {
      if (++calls === 4) {
        budget = false;
        started();
      }
      await held;
    });
    let settled = false;
    const run = publishWebSocketOutbox(
      send,
      db as unknown as SqlExecutor,
      () => budget
    ).then((result) => {
      settled = true;
      return result;
    });
    await allStarted;
    expect(settled).toBe(false);
    expect(db.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(4);
    release();
    expect(await run).toBe(4);
    expect(send).toHaveBeenCalledTimes(4);
    expect(db.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(4);
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
