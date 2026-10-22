jest.mock('@/sql-executor', () => ({ dbSupplier: jest.fn() }));
import { dbSupplier } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { readLoopHealthRows } from './loop-health-read';

it('restricts the diagnostic scope to SELECT queries', () => {
  expect(() => readLoopHealthRows('update a set b = 1')).toThrow(
    'LOOP_HEALTH_READ_ONLY'
  );
});

it('owns a bounded writer connection and awaits its cleanup for diagnostic reads', async () => {
  const connection = { connection: {} };
  const execute = jest.fn().mockResolvedValue([{ oldest: null }]);
  const transaction = jest.fn(
    async (work: (value: typeof connection) => Promise<unknown>) =>
      work(connection)
  );
  jest.mocked(dbSupplier).mockReturnValue({
    execute,
    executeNativeQueriesInTransaction: transaction
  } as never);
  await expect(
    readLoopHealthRows('select oldest', { test: 1 })
  ).resolves.toEqual([{ oldest: null }]);
  expect(execute).toHaveBeenCalledWith(
    'select oldest',
    { test: 1 },
    {
      wrappedConnection: connection,
      forcePool: DbPoolName.WRITE,
      bindInvocationContext: true
    }
  );
  expect(transaction).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({
      executionBudget: expect.objectContaining({
        maxStatementMillis: 1000,
        finalizationReserveMillis: 250
      })
    })
  );
});
