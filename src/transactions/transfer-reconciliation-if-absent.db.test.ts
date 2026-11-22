import { TRANSFER_RECONCILIATIONS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { transferReconciliationDb } from './transfer-reconciliation.db';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

async function queue() {
  return sqlExecutor.execute<{
    consumer: string;
    wallet: string;
    revision: string;
    enqueue_order: number;
  }>(
    `SELECT consumer, wallet, revision, enqueue_order
     FROM ${TRANSFER_RECONCILIATIONS_TABLE} ORDER BY enqueue_order`
  );
}

describe('enqueueIfAbsent', () => {
  afterEach(async () => {
    await sqlExecutor.execute(`DELETE FROM ${TRANSFER_RECONCILIATIONS_TABLE}`);
  });

  it('adds missing wallets and leaves a waiting one with its place and revision', async () => {
    await sqlExecutor.execute(`DELETE FROM ${TRANSFER_RECONCILIATIONS_TABLE}`);
    await transferReconciliationDb.publishBalances([wallet(1)]);
    const [waiting] = await queue();

    await transferReconciliationDb.enqueueIfAbsent(
      [wallet(1), wallet(2)],
      'balances'
    );

    const rows = await queue();
    expect(rows.map((row) => row.wallet)).toEqual([wallet(1), wallet(2)]);
    expect(rows[0]).toEqual(waiting);
    // An in-flight run that read the waiting row still acknowledges it.
    await transferReconciliationDb.acknowledge([
      { ...waiting, consumer: 'balances', requested_at: 0 }
    ]);
    expect((await queue()).map((row) => row.wallet)).toEqual([wallet(2)]);
  });
});
