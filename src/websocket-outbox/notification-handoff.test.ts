import { retainQueuedNotificationInvalidations } from './notification-handoff';
import { SqlExecutor } from '@/sql-executor';
it('persists one invalidation per identity and propagates failed acceptance to the source queue', async () => {
  const bulkInsert = jest.fn().mockResolvedValue(undefined);
  const connection = { connection: {} };
  const db = {
    bulkInsert,
    executeNativeQueriesInTransaction: jest.fn(async (work) => work(connection))
  } as unknown as SqlExecutor;
  await retainQueuedNotificationInvalidations(['p', 'p', 'other'], db);
  expect(bulkInsert.mock.calls[0][1]).toHaveLength(2);
  bulkInsert.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(
    retainQueuedNotificationInvalidations(['p'], db)
  ).rejects.toThrow('database unavailable');
});

const originalNodeEnvironment = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnvironment;
});
