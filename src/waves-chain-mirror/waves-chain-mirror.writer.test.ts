import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import { WriterPoolExecutor } from './waves-chain-mirror.writer';

describe('WriterPoolExecutor', () => {
  it("sends every statement outside a transaction to the writer, and a transaction's as they are", async () => {
    const inner = {
      execute: jest.fn().mockResolvedValue([]),
      executeNativeQueriesInTransaction: jest.fn(
        async (fn: (c: unknown) => unknown) => fn({ connection: 'c' })
      ),
      getAffectedRows: jest.fn().mockReturnValue(3)
    };
    const writer = new WriterPoolExecutor(
      () => inner as unknown as SqlExecutor
    );
    await writer.execute('select 1', { a: 1 });
    expect(inner.execute).toHaveBeenLastCalledWith(
      'select 1',
      { a: 1 },
      { forcePool: DbPoolName.WRITE }
    );
    const connection = { connection: 'c' };
    await writer.execute('select 2', {}, { wrappedConnection: connection });
    expect(inner.execute).toHaveBeenLastCalledWith(
      'select 2',
      {},
      { wrappedConnection: connection }
    );
    await writer.executeNativeQueriesInTransaction(async () => 1, {
      isolationLevel: 'READ COMMITTED'
    });
    expect(inner.executeNativeQueriesInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'READ COMMITTED' }
    );
    expect(writer.getAffectedRows({})).toBe(3);
  });
});
