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
