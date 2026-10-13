import { TransferReconciliationDb } from './transfer-reconciliation.db';
import { SqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';

const execute = jest.fn().mockResolvedValue([]);
const db = new TransferReconciliationDb(
  () => ({ execute }) as unknown as SqlExecutor
);
const rows = ['0xalice', '0xbob'].map((wallet) => ({
  consumer: 'owners' as const,
  wallet,
  revision: 'consumed-revision',
  requested_at: 1
}));
beforeEach(() => execute.mockClear());
it('acknowledges a batch in one guarded primary delete', async () => {
  await db.acknowledge(rows);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining('(consumer, wallet, revision) IN (:keys)'),
    { keys: rows.map((row) => [row.consumer, row.wallet, row.revision]) },
    { forcePool: DbPoolName.WRITE, wrappedConnection: undefined }
  );
});
it('does nothing for an empty acknowledgement batch', async () => {
  await db.acknowledge([]);
  expect(execute).not.toHaveBeenCalled();
});
it('uses database insertion order when selecting a bounded pending batch', async () => {
  await db.pending('owners');
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining('ORDER BY enqueue_order LIMIT :limit'),
    { consumer: 'owners', limit: 250 },
    expect.objectContaining({ forcePool: DbPoolName.WRITE })
  );
});
