import { MEMELAB_CONTRACT, NULL_ADDRESS } from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { buildTransaction } from '@/tests/test.transactions.helpers';
import { TransactionsDiscoveryDb } from './transactions.discovery.db';
import {
  TransferReconciliationDb,
  enqueueTransfersWithManager,
  transferReconciliationDb
} from './transfer-reconciliation.db';
import { DataSource } from 'typeorm';
import { Transaction } from '@/entities/ITransaction';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
function lateTransfer() {
  const tx = buildTransaction(A, B, MEMELAB_CONTRACT, 71);
  tx.block = 26056042;
  return tx;
}

describeWithSeed('Transfer reconciliation durable requests', [], () => {
  const db = new TransferReconciliationDb(() => sqlExecutor);
  const discovery = new TransactionsDiscoveryDb(() => sqlExecutor);

  it('records an older transfer even after another contract advanced the global block', async () => {
    const ahead = buildTransaction(NULL_ADDRESS, A, MEMELAB_CONTRACT, 70);
    ahead.block = 26056044;
    await discovery.batchUpsertTransactions([ahead]);
    await db.acknowledge(await db.pending('owners'));
    await discovery.batchUpsertTransactions([lateTransfer()]);
    expect(await db.changes([MEMELAB_CONTRACT], 26056044, 26056044)).toEqual(
      []
    );
    expect((await db.pending('owners')).map((row) => row.wallet)).toEqual([
      A,
      B
    ]);
    expect((await db.pending('activity')).map((row) => row.wallet)).toEqual([
      NULL_ADDRESS,
      A,
      B
    ]);
    expect(
      (await db.history([MEMELAB_CONTRACT], [B], 26056044)).map(
        (tx) => tx.block
      )
    ).toEqual([26056042]);
  });

  it('rolls back the transfer itself when enqueueing its refresh fails', async () => {
    const enqueue = jest
      .spyOn(transferReconciliationDb, 'enqueue')
      .mockRejectedValueOnce(new Error('queue unavailable'));
    const tx = lateTransfer();
    try {
      await expect(discovery.batchUpsertTransactions([tx])).rejects.toThrow(
        'queue unavailable'
      );
      expect(
        await sqlExecutor.execute(
          'SELECT * FROM transactions WHERE transaction = :hash',
          { hash: tx.transaction }
        )
      ).toEqual([]);
      expect(await db.pending('owners')).toEqual([]);
    } finally {
      enqueue.mockRestore();
    }
  });

  it('does not lose a producer commit made after a consumer read the request', async () => {
    await discovery.batchUpsertTransactions([lateTransfer()]);
    const consumed = await db.pending('owners');
    await discovery.batchUpsertTransactions([lateTransfer()]);
    await db.acknowledge(consumed);
    const remaining = await db.pending('owners');
    expect(remaining).toHaveLength(2);
    expect(remaining[0].revision).not.toBe(consumed[0].revision);
    await db.acknowledge(remaining);
    expect(await db.pending('owners')).toEqual([]);
    expect(await db.pending('activity')).toHaveLength(2);
  });

  it('rolls back pending requests with the failed enclosing transfer transaction', async () => {
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        await db.enqueue([A, B], ['owners', 'activity'], { connection });
        throw new Error('abort transfer');
      })
    ).rejects.toThrow('abort transfer');
    expect(await db.pending('owners')).toEqual([]);
    expect(await db.pending('activity')).toEqual([]);
  });

  it('bounds draining to 250 wallets without deleting unprocessed work', async () => {
    const wallets = Array.from(
      { length: 260 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`
    );
    await db.enqueueRepair(wallets);
    const first = await db.pending('owners');
    expect(first).toHaveLength(250);
    await db.acknowledge(first);
    expect(await db.pending('owners')).toHaveLength(10);
    expect(await db.pending('activity')).toHaveLength(250);
  });

  it('publishes balances independently and keeps them pending if refreshed again', async () => {
    await db.publishBalances([A]);
    const first = await db.pending('balances');
    await db.publishBalances([A]);
    await db.acknowledge(first);
    expect(await db.pending('balances')).toHaveLength(1);
  });

  it('drains in database insertion order despite producer clock skew', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValueOnce(2000);
      await db.enqueueRepair([B]);
      now.mockReturnValueOnce(1000);
      await db.enqueueRepair([A]);
      expect((await db.pending('owners')).map((row) => row.wallet)).toEqual([
        B,
        A
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it('requires enqueueing on the caller transaction', async () => {
    await expect(db.enqueue([A], ['owners'], {})).rejects.toThrow(
      'requires a transaction'
    );
  });

  it('covers the TypeORM transaction path used by NextGen and legacy persistence', async () => {
    const source = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities: [Transaction],
      synchronize: false,
      timezone: 'Etc/UTC'
    });
    await source.initialize();
    try {
      const tx = lateTransfer();
      await source.transaction(async (manager) => {
        await manager.getRepository(Transaction).save(tx);
        await enqueueTransfersWithManager(manager, [tx]);
      });
      expect(await db.pending('owners')).toHaveLength(2);
      const consumed = await db.pending('owners');
      await source.transaction(async (manager) =>
        enqueueTransfersWithManager(manager, [tx])
      );
      await db.acknowledge(consumed);
      expect(await db.pending('owners')).toHaveLength(2);
      await db.acknowledge(await db.pending('owners'));
      await expect(
        source.transaction(async (manager) => {
          await enqueueTransfersWithManager(manager, [tx]);
          throw new Error('abort');
        })
      ).rejects.toThrow('abort');
      expect(await db.pending('owners')).toEqual([]);
    } finally {
      await source.destroy();
    }
  });
});
