import { MEMELAB_CONTRACT, NULL_ADDRESS } from '@/constants';
import { Transaction } from '@/entities/ITransaction';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { updateNftOwners } from './nft_owners';
import {
  persistNftOwners,
  persistConsolidatedNftOwners,
  getNftOwnersSyncBlock
} from './db.nft_owners';

jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferWallets: (rows: Transaction[]) =>
    rows.flatMap((tx) => [tx.from_address, tx.to_address]),
  transferReconciliationDb: {
    pending: jest.fn(),
    maxBlock: jest.fn(),
    changes: jest.fn(),
    history: jest.fn(),
    acknowledge: jest.fn(),
    publishBalances: jest.fn()
  }
}));
jest.mock('@/db', () => ({
  fetchConsolidationGroupsForAddresses: jest.fn(async () => new Map())
}));
jest.mock('./db.nft_owners', () => ({
  getMaxNftOwnersBlockReference: jest.fn(async () => 26056044),
  getNftOwnersSyncBlock: jest.fn(async () => 26056044),
  setNftOwnersSyncBlock: jest.fn(),
  fetchAllNftOwners: jest.fn(),
  persistNftOwners: jest.fn(),
  persistConsolidatedNftOwners: jest.fn()
}));

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const pending = [A, B].map((wallet) => ({
  wallet,
  consumer: 'owners' as const,
  revision: 'old',
  requested_at: 1
}));
const transfer = (hash: string, from: string, to: string, count: number) =>
  ({
    transaction: hash,
    contract: MEMELAB_CONTRACT,
    token_id: 71,
    token_count: count,
    block: 26056042,
    from_address: from,
    to_address: to
  }) as Transaction;
const ledger = [
  transfer('mint', NULL_ADDRESS, A, 3),
  transfer('late', A, B, 1)
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(transferReconciliationDb.pending).mockResolvedValue(pending);
  jest.mocked(transferReconciliationDb.maxBlock).mockResolvedValue(26056044);
  jest.mocked(transferReconciliationDb.changes).mockResolvedValue([]);
  jest.mocked(transferReconciliationDb.history).mockResolvedValue(ledger);
  jest.mocked(persistNftOwners).mockResolvedValue(undefined);
  jest.mocked(getNftOwnersSyncBlock).mockResolvedValue(26056044);
});

it('repairs a transfer inserted behind an unchanged global block checkpoint and replay is idempotent', async () => {
  await updateNftOwners();
  await updateNftOwners();
  for (const [, owners] of jest.mocked(persistNftOwners).mock.calls) {
    expect(owners.map((row) => [row.wallet, row.balance])).toEqual([
      [A, 2],
      [B, 1]
    ]);
  }
  expect(transferReconciliationDb.publishBalances).toHaveBeenCalledWith([A, B]);
  expect(transferReconciliationDb.acknowledge).toHaveBeenCalledWith(pending);
});

it('clears a wallet that transferred its final token instead of retaining its stale row', async () => {
  jest
    .mocked(transferReconciliationDb.history)
    .mockResolvedValue([
      transfer('mint', NULL_ADDRESS, A, 1),
      transfer('late', A, B, 1)
    ]);
  await updateNftOwners();
  expect(persistNftOwners).toHaveBeenCalledWith(
    new Set([A, B]),
    [expect.objectContaining({ wallet: B, balance: 1 })],
    false
  );
});

it('keeps pending work after a raw ownership write fails', async () => {
  jest
    .mocked(persistNftOwners)
    .mockRejectedValueOnce(new Error('write failed'));
  await expect(updateNftOwners()).rejects.toThrow('write failed');
  expect(transferReconciliationDb.acknowledge).not.toHaveBeenCalled();
  expect(transferReconciliationDb.publishBalances).not.toHaveBeenCalled();
});

it('does not acknowledge before both ownership publications and the downstream balance request succeed', async () => {
  jest
    .mocked(transferReconciliationDb.publishBalances)
    .mockRejectedValueOnce(new Error('queue failed'));
  await expect(updateNftOwners()).rejects.toThrow('queue failed');
  expect(persistNftOwners).toHaveBeenCalled();
  expect(persistConsolidatedNftOwners).toHaveBeenCalled();
  expect(transferReconciliationDb.acknowledge).not.toHaveBeenCalled();
});
