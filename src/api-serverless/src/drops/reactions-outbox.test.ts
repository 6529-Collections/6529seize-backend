import { ReactionsDb } from './reactions.db';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';

const originalEnvironment = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
});

it.each([
  ['add', false],
  ['remove', false],
  ['add', true],
  ['remove', true]
] as const)(
  '%s keeps reaction and outbox writes on one connection (existing=%s)',
  async (operation, existing) => {
    const connection = { connection: {} };
    const execute = jest
      .fn()
      .mockResolvedValue({ affectedRows: 1, insertId: 1 });
    const transaction = jest.fn(async (work) => work(connection));
    const db = {
      execute,
      executeNativeQueriesInTransaction: transaction,
      getAffectedRows: () => 1
    } as unknown as SqlExecutor;
    const repository = new ReactionsDb(() => db);
    const ctx: RequestContext = existing ? { connection } : {};
    const changed =
      operation === 'add'
        ? await repository.addReaction('profile', 'drop', 'wave', 'like', ctx)
        : await repository.removeReaction('profile', 'drop', 'wave', ctx);
    expect(changed).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![0]).toContain('drop_reactions');
    expect(execute.mock.calls[1]![0]).toContain('websocket_outbox');
    for (const call of execute.mock.calls)
      expect(call[2]).toEqual({ wrappedConnection: connection });
  }
);

it.each([
  ['new reaction', { insertId: 11, affectedRows: 1, changedRows: 0 }, true],
  ['overwrite', { insertId: 0, affectedRows: 2, changedRows: 0 }, true],
  [
    'changed-row result',
    { insertId: 0, affectedRows: 1, changedRows: 1 },
    true
  ],
  [
    'unchanged reaction',
    { insertId: 0, affectedRows: 0, changedRows: 0 },
    false
  ],
  [
    'unchanged reaction with found rows',
    { insertId: 0, affectedRows: 1, changedRows: 0 },
    false
  ]
])(
  'records exactly one event only for a changed %s',
  async (_label, result, changed) => {
    const connection = { connection: {} };
    const execute = jest
      .fn()
      .mockResolvedValueOnce(result)
      .mockResolvedValue(undefined);
    const db = {
      execute,
      getAffectedRows: (write: { affectedRows: number }) => write.affectedRows
    } as unknown as SqlExecutor;
    const repository = new ReactionsDb(() => db);
    await expect(
      repository.addReaction('profile', 'drop', 'wave', 'like', { connection })
    ).resolves.toBe(changed);
    const events = execute.mock.calls.filter(([sql]) =>
      sql.includes('websocket_outbox')
    );
    expect(events).toHaveLength(changed ? 1 : 0);
    if (changed) {
      expect(JSON.parse(events[0][1].event)).toEqual({
        type: 'drop',
        dropId: 'drop',
        updateType: 'DROP_REACTION_UPDATE'
      });
      expect(events[0][2]).toEqual({ wrappedConnection: connection });
    }
  }
);

it.each([false, true])(
  'does not capture a no-op reaction delete (existing=%s)',
  async (existing) => {
    const connection = { connection: {} };
    const execute = jest.fn().mockResolvedValue({ affectedRows: 0 });
    const transaction = jest.fn(async (work) => work(connection));
    const db = {
      execute,
      executeNativeQueriesInTransaction: transaction,
      getAffectedRows: () => 0
    } as unknown as SqlExecutor;
    const repository = new ReactionsDb(() => db);
    await expect(
      repository.removeReaction(
        'profile',
        'drop',
        'wave',
        existing ? { connection } : {}
      )
    ).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('DELETE FROM drop_reactions');
    expect(transaction).toHaveBeenCalledTimes(existing ? 0 : 1);
  }
);

it.each([false, true])(
  'propagates outbox failure on the same mutation connection (existing=%s)',
  async (existing) => {
    const connection = { connection: {} };
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ insertId: 1, affectedRows: 1 })
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    const transaction = jest.fn(async (work) => work(connection));
    const db = {
      execute,
      executeNativeQueriesInTransaction: transaction,
      getAffectedRows: () => 1
    } as unknown as SqlExecutor;
    const repository = new ReactionsDb(() => db);
    await expect(
      repository.addReaction(
        'profile',
        'drop',
        'wave',
        'like',
        existing ? { connection } : {}
      )
    ).rejects.toThrow('outbox unavailable');
    expect(transaction).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(execute).toHaveBeenCalledTimes(2);
    for (const call of execute.mock.calls)
      expect(call[2]).toEqual({ wrappedConnection: connection });
  }
);
