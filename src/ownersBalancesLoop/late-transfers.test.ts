import { updateOwnerBalances } from './owners_balances';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import {
  persistOwnerBalances,
  persistConsolidatedOwnerBalances
} from './db.owners_balances';
import { NFTOwner } from '@/entities/INFTOwner';
import { MEMELAB_CONTRACT } from '@/constants';
import { fetchAllNftOwners } from '@/nftOwnersLoop/db.nft_owners';

jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: {
    pending: jest.fn(),
    acknowledge: jest.fn()
  }
}));
jest.mock('@/db', () => ({
  fetchAllSeasons: jest.fn(async () => []),
  fetchTransactionAddressesFromBlock: jest.fn(async () => []),
  fetchWalletConsolidationKeysViewForWallet: jest.fn(async () => [])
}));
jest.mock('@/nftOwnersLoop/db.nft_owners', () => ({
  getMaxNftOwnersBlockReference: jest.fn(async () => 26056044),
  fetchAllNftOwners: jest.fn()
}));
jest.mock('./db.owners_balances', () => ({
  getMaxOwnerBalancesBlockReference: jest.fn(async () => 26056044),
  fetchRefreshOutdatedBalances: jest.fn(async () => []),
  persistOwnerBalances: jest.fn(),
  persistConsolidatedOwnerBalances: jest.fn()
}));
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const pending = [A, B].map((wallet) => ({
  wallet,
  consumer: 'balances' as const,
  revision: 'old',
  requested_at: 1
}));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(transferReconciliationDb.pending).mockResolvedValue(pending);
  jest.mocked(fetchAllNftOwners).mockResolvedValue([
    {
      wallet: B,
      contract: MEMELAB_CONTRACT,
      token_id: 71,
      balance: 1,
      block_reference: 26056044
    } as NFTOwner
  ]);
});
it('refreshes raw and consolidated balances even without a newer transaction block and deletes a sold-out wallet', async () => {
  await updateOwnerBalances();
  expect(persistOwnerBalances).toHaveBeenCalledWith(
    [expect.objectContaining({ wallet: B, memelab_balance: 1 })],
    [],
    new Set([A]),
    false
  );
  expect(persistConsolidatedOwnerBalances).toHaveBeenCalled();
  expect(transferReconciliationDb.acknowledge).toHaveBeenCalledWith(pending);
});
it('does not acknowledge when consolidated balance writes fail', async () => {
  jest
    .mocked(persistConsolidatedOwnerBalances)
    .mockRejectedValueOnce(new Error('publish failed'));
  await expect(updateOwnerBalances()).rejects.toThrow('publish failed');
  expect(transferReconciliationDb.acknowledge).not.toHaveBeenCalled();
});
