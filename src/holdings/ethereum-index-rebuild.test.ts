import { updateAggregatedActivity } from '@/aggregatedActivityLoop/aggregated_activity';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { updateNftOwners } from '@/nftOwnersLoop/nft_owners';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from '@/nftsLoop/nft-extended-data';
import { NFT_MODE, processNFTs } from '@/nftsLoop/nfts';
import { updateOwnerBalances } from '@/ownersBalancesLoop/owners_balances';
import { transactionsDiscoveryService } from '@/transactions/transactions-discovery.service';
import {
  rebuildHoldingsBalances,
  rebuildNftCatalogue,
  rebuildNftOwners,
  rebuildTransactions
} from './ethereum-index-rebuild';
import { isRebuildingEthereumIndexes } from './rebuild-mode';

jest.mock('@/aggregatedActivityLoop/aggregated_activity', () => ({
  updateAggregatedActivity: jest.fn()
}));
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('@/nftOwnersLoop/nft_owners', () => ({ updateNftOwners: jest.fn() }));
jest.mock('@/nftsLoop/nft-extended-data', () => ({
  findMemesExtendedData: jest.fn(),
  findMemeLabExtendedData: jest.fn()
}));
jest.mock('@/nftsLoop/nfts', () => ({
  NFT_MODE: { DISCOVER: 'discover', REFRESH: 'refresh' },
  processNFTs: jest.fn()
}));
jest.mock('@/ownersBalancesLoop/owners_balances', () => ({
  updateOwnerBalances: jest.fn()
}));
jest.mock('@/transactions/transactions-discovery.service', () => ({
  transactionsDiscoveryService: {
    getAndSaveTransactionsForContract: jest.fn()
  }
}));

const steps = [
  updateNftOwners,
  updateAggregatedActivity,
  updateOwnerBalances,
  processNFTs,
  findMemesExtendedData,
  findMemeLabExtendedData,
  transactionsDiscoveryService.getAndSaveTransactionsForContract
];
let modes: boolean[];

/** Calls of `fns`, in the order they ran. */
function order(...fns: jest.Mock[]): number[] {
  return fns.flatMap((fn) => fn.mock.invocationCallOrder);
}

beforeEach(() => {
  jest.clearAllMocks();
  modes = [];
  for (const fn of steps) {
    jest.mocked(fn as jest.Mock).mockImplementation(async () => {
      modes.push(isRebuildingEthereumIndexes());
    });
  }
});

afterEach(() => {
  // Every loop function ran in rebuild mode, and the mode is left after.
  expect(modes.every(Boolean)).toBe(true);
  expect(isRebuildingEthereumIndexes()).toBe(false);
});

describe('Ethereum index rebuild steps', () => {
  it("discovers each contract's transactions up to the run's mark", async () => {
    await rebuildTransactions({ mark: { ethBlock: 900 } });
    expect(
      jest.mocked(
        transactionsDiscoveryService.getAndSaveTransactionsForContract
      ).mock.calls
    ).toEqual([
      [MEMES_CONTRACT, null, 900],
      [GRADIENT_CONTRACT, null, 900],
      [MEMELAB_CONTRACT, null, 900]
    ]);
  });

  it('goes to the finalized block when the run names no mark', async () => {
    jest
      .mocked(getEthereumRpcClient)
      .mockReturnValue({ getBlock: async () => ({ number: 77 }) } as never);
    await rebuildTransactions({ mark: { ethBlock: null } });
    expect(
      transactionsDiscoveryService.getAndSaveTransactionsForContract
    ).toHaveBeenCalledWith(MEMES_CONTRACT, null, 77);
  });

  it('resets the owners, then the catalogue and seasons, then activity and balances', async () => {
    await rebuildNftOwners();
    await rebuildNftCatalogue();
    await rebuildHoldingsBalances();

    expect(updateNftOwners).toHaveBeenCalledWith(true);
    expect(jest.mocked(processNFTs).mock.calls).toEqual([
      [NFT_MODE.DISCOVER],
      [NFT_MODE.REFRESH]
    ]);
    expect(updateAggregatedActivity).toHaveBeenCalledWith(true);
    expect(updateOwnerBalances).toHaveBeenCalledWith(true);
    const ran = order(
      jest.mocked(updateNftOwners),
      jest.mocked(processNFTs),
      jest.mocked(findMemesExtendedData),
      jest.mocked(findMemeLabExtendedData),
      jest.mocked(updateAggregatedActivity),
      jest.mocked(updateOwnerBalances)
    );
    expect(ran).toEqual([...ran].sort((a, b) => a - b));
  });
});
