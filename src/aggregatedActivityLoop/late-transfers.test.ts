import { updateAggregatedActivity } from './aggregated_activity';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { fetchWalletTransactions } from '@/db';
import { Transaction } from '@/entities/ITransaction';
import { MEMELAB_CONTRACT, MEMES_CONTRACT } from '@/constants';
import {
  persistActivity,
  persistConsolidatedActivity
} from './db.aggregated_activity';
import { DbPoolName } from '@/db-query.options';

jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: {
    pending: jest.fn(),
    maxBlock: jest.fn(async () => 26056044),
    changes: jest.fn(async () => []),
    acknowledge: jest.fn()
  }
}));
jest.mock('@/db', () => ({
  fetchAllSeasons: jest.fn(async () => []),
  fetchWalletTransactions: jest.fn(),
  fetchConsolidationGroupsForAddresses: jest.fn(async () => new Map())
}));
jest.mock('./db.aggregated_activity', () => ({
  getMaxAggregatedActivityBlockReference: jest.fn(async () => 26056044),
  persistActivity: jest.fn(),
  persistConsolidatedActivity: jest.fn()
}));
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const pending = [A, B].map((wallet) => ({
  wallet,
  consumer: 'activity' as const,
  revision: 'old',
  requested_at: 1
}));
const late = {
  contract: MEMELAB_CONTRACT,
  transaction: 'late',
  block: 26056042,
  from_address: A,
  to_address: B,
  token_id: 71,
  token_count: 1,
  value: 0
} as Transaction;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(transferReconciliationDb.pending).mockResolvedValue(pending);
  jest.mocked(fetchWalletTransactions).mockResolvedValue([late]);
});
it('refreshes late transfer activity at an unchanged block and uses primary capped histories', async () => {
  await updateAggregatedActivity();
  const rows = jest.mocked(persistActivity).mock.calls[0][0];
  expect(rows.find((row) => row.wallet === A)?.transfers_out_memelab).toBe(1);
  expect(rows.find((row) => row.wallet === B)?.transfers_in_memelab).toBe(1);
  expect(fetchWalletTransactions).toHaveBeenCalledWith(
    expect.any(Array),
    A,
    26056044,
    { forcePool: DbPoolName.WRITE }
  );
  expect(transferReconciliationDb.acknowledge).toHaveBeenCalledWith(pending);
});
it('retains pending work when consolidated publication fails', async () => {
  jest
    .mocked(persistConsolidatedActivity)
    .mockRejectedValueOnce(new Error('publish failed'));
  await expect(updateAggregatedActivity()).rejects.toThrow('publish failed');
  expect(transferReconciliationDb.acknowledge).not.toHaveBeenCalled();
});
it('does not acknowledge a late Meme transfer when season metadata is unavailable', async () => {
  jest
    .mocked(fetchWalletTransactions)
    .mockResolvedValue([{ ...late, contract: MEMES_CONTRACT }]);
  await expect(updateAggregatedActivity()).rejects.toThrow('season metadata');
  expect(persistActivity).not.toHaveBeenCalled();
  expect(transferReconciliationDb.acknowledge).not.toHaveBeenCalled();
});
