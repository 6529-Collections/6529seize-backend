import { JsonRpcProvider } from 'ethers';
import {
  NULL_ADDRESS,
  TRANSACTION_SCAN_CHECKPOINTS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { buildTransaction } from '@/tests/test.transactions.helpers';
import { TransactionsDiscoveryDb } from './transactions.discovery.db';
import {
  checkpointTransactionScan,
  readScanCheckpoint
} from './transaction-scan-checkpoint';
import { indexedMintTotals } from '@/drop-forge/drop-forge.supply';

const contract = '0x' + 'd1'.repeat(20);
const wallet = '0x' + 'd2'.repeat(20);
const hash = '0x' + 'd3'.repeat(32);
const discovery = new TransactionsDiscoveryDb(() => sqlExecutor);
function provider(number: number) {
  return {
    getBlock: jest.fn().mockResolvedValue({ number, hash })
  } as unknown as JsonRpcProvider;
}
describeWithSeed('Finalized transaction scan coverage', [], () => {
  beforeEach(async () => {
    await sqlExecutor.execute(
      `DELETE FROM ${TRANSACTION_SCAN_CHECKPOINTS_TABLE}`
    );
    await sqlExecutor.execute(
      `DELETE FROM ${TRANSACTIONS_TABLE} WHERE contract = :contract`,
      { contract }
    );
  });
  it('persists empty-block coverage and counts cumulative minting without subtracting burns', async () => {
    const mint = {
      ...buildTransaction(NULL_ADDRESS, wallet, contract, 1, 287),
      block: 90
    };
    const burn = {
      ...buildTransaction(wallet, NULL_ADDRESS, contract, 1, 2),
      block: 91
    };
    const later = {
      ...buildTransaction(NULL_ADDRESS, wallet, contract, 1, 1),
      block: 101
    };
    await discovery.batchUpsertTransactions([mint, burn, later]);
    await checkpointTransactionScan(
      1,
      contract,
      provider(100),
      async (start, end) => {
        expect([start, end]).toEqual([100, 100]);
      }
    );
    expect(await readScanCheckpoint(1, contract)).toMatchObject({
      block: 100,
      block_hash: hash
    });
    expect(await indexedMintTotals({ contract, claim_id: 1 }, 100)).toEqual({
      total: 287,
      paid: 0
    });
  });
  it('does not regress coverage when an older concurrent scan finishes last', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = checkpointTransactionScan(
      1,
      contract,
      provider(100),
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    );
    await waiting;
    await checkpointTransactionScan(
      1,
      contract,
      provider(110),
      async () => undefined
    );
    release();
    await first;
    expect(await readScanCheckpoint(1, contract)).toMatchObject({
      block: 110,
      block_hash: hash
    });
  });
  it('does not create coverage evidence when scanning fails', async () => {
    await expect(
      checkpointTransactionScan(1, contract, provider(100), async () => {
        throw new Error('pagination interrupted');
      })
    ).rejects.toThrow('pagination interrupted');
    expect(await readScanCheckpoint(1, contract)).toBeNull();
  });
});
