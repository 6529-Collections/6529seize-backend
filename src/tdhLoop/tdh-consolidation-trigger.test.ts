const mockFetchAllConsolidatedTdh = jest.fn();
const mockFetchAllTdh = jest.fn();
const mockFetchConsolidationDisplay = jest.fn();
const mockFetchConsolidationDisplays = jest.fn();
const mockFetchLatestTdhBlockNumber = jest.fn();
const mockPersistConsolidatedTdh = jest.fn();
const mockPersistTdhBlock = jest.fn();
const mockRetrieveConsolidationsForWallets = jest.fn();
const mockRetrieveWalletConsolidations = jest.fn();
const mockFetchNextgenTokens = jest.fn();
const mockCalculateBoosts = jest.fn();
const mockCalculateRanks = jest.fn();
const mockGetAdjustedMemesAndSeasons = jest.fn();
const mockCalculateMemesTdh = jest.fn();
const mockCalculateTdhEditions = jest.fn();
const mockCalculateNftTdh = jest.fn();
const mockSqsSendToQueueName = jest.fn();

jest.mock('@/db', () => ({
  fetchAllConsolidatedTdh: mockFetchAllConsolidatedTdh,
  fetchAllTDH: mockFetchAllTdh,
  fetchConsolidationDisplay: mockFetchConsolidationDisplay,
  fetchConsolidationDisplays: mockFetchConsolidationDisplays,
  fetchLatestTDHBlockNumber: mockFetchLatestTdhBlockNumber,
  persistConsolidatedTDH: mockPersistConsolidatedTdh,
  persistTDHBlock: mockPersistTdhBlock,
  retrieveConsolidationsForWallets: mockRetrieveConsolidationsForWallets,
  retrieveWalletConsolidations: mockRetrieveWalletConsolidations
}));

jest.mock('@/nextgen/nextgen.db', () => ({
  fetchNextgenTokens: mockFetchNextgenTokens
}));

jest.mock('./tdh', () => ({
  calculateBoosts: mockCalculateBoosts,
  calculateRanks: mockCalculateRanks,
  createMemesData: jest.fn(() => ({
    memes_tdh: 0,
    memes_tdh__raw: 0,
    memes_balance: 0,
    boosted_memes_tdh: 0,
    memes_ranks: []
  })),
  getAdjustedMemesAndSeasons: mockGetAdjustedMemesAndSeasons,
  getGenesisAndNaka: jest.fn(() => ({ genesis: 0, naka: 0 }))
}));

jest.mock('./tdh_memes', () => ({
  calculateMemesTdh: mockCalculateMemesTdh
}));

jest.mock('./tdh_editions', () => ({
  calculateTdhEditions: mockCalculateTdhEditions
}));

jest.mock('./tdh_nft', () => ({
  calculateNftTDH: mockCalculateNftTdh
}));

jest.mock('@/sqs', () => ({
  sqs: {
    sendToQueueName: mockSqsSendToQueueName
  }
}));

import { consolidateAndPersistTDH } from './tdh_consolidation';

describe('TDH consolidation xTDH trigger contract', () => {
  const block = 123;
  const blockTimestamp = new Date('2026-08-31T00:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAllTdh.mockResolvedValue([]);
    mockFetchAllConsolidatedTdh.mockResolvedValue([]);
    mockFetchConsolidationDisplays.mockResolvedValue({});
    mockFetchLatestTdhBlockNumber.mockResolvedValue(block);
    mockRetrieveConsolidationsForWallets.mockResolvedValue({});
    mockRetrieveWalletConsolidations.mockImplementation(
      async (wallet: string) => [wallet]
    );
    mockFetchConsolidationDisplay.mockResolvedValue('wallet');
    mockFetchNextgenTokens.mockResolvedValue([]);
    mockGetAdjustedMemesAndSeasons.mockResolvedValue({
      ADJUSTED_NFTS: [],
      MEMES_COUNT: 0,
      ADJUSTED_SEASONS: []
    });
    mockCalculateBoosts.mockImplementation(
      async (_seasons: unknown[], consolidations: unknown[]) => consolidations
    );
    mockCalculateRanks.mockImplementation(
      async (_nfts: unknown[], consolidations: unknown[]) => consolidations
    );
    mockCalculateMemesTdh.mockResolvedValue([]);
    mockCalculateTdhEditions.mockResolvedValue([]);
    mockCalculateNftTdh.mockReturnValue([]);
    mockPersistConsolidatedTdh.mockResolvedValue(undefined);
    mockPersistTdhBlock.mockResolvedValue(undefined);
    mockSqsSendToQueueName.mockResolvedValue(undefined);
  });

  it('does not directly enqueue xTDH for a full nightly consolidation', async () => {
    await consolidateAndPersistTDH(block, blockTimestamp, { mode: 'FULL' });

    expect(mockPersistConsolidatedTdh).toHaveBeenCalledWith(
      block,
      [],
      [],
      [],
      [],
      { mode: 'FULL' }
    );
    expect(mockPersistTdhBlock).toHaveBeenCalledTimes(1);
    expect(mockSqsSendToQueueName).not.toHaveBeenCalled();
  });

  it('directly enqueues xTDH once after partial persistence completes', async () => {
    const wallets = ['0xabc'];

    await consolidateAndPersistTDH(block, blockTimestamp, {
      mode: 'PARTIAL',
      wallets,
      currentConsolidatedTdh: []
    });

    expect(mockPersistConsolidatedTdh).toHaveBeenCalledWith(
      block,
      expect.any(Array),
      [],
      [],
      [],
      {
        mode: 'PARTIAL',
        wallets,
        consolidationKeysToReplace: []
      }
    );
    expect(mockSqsSendToQueueName).toHaveBeenCalledWith({
      queueName: 'xtdh-start.fifo',
      message: {
        phase: 'universe',
        queued_at_ms: expect.any(Number)
      }
    });
    expect(mockSqsSendToQueueName).toHaveBeenCalledTimes(1);
    expect(mockPersistTdhBlock.mock.invocationCallOrder[0]).toBeLessThan(
      mockSqsSendToQueueName.mock.invocationCallOrder[0]
    );
  });

  it('does not enqueue xTDH when consolidated persistence fails', async () => {
    mockPersistConsolidatedTdh.mockRejectedValueOnce(
      new Error('persistence transaction failed')
    );

    await expect(
      consolidateAndPersistTDH(block, blockTimestamp, {
        mode: 'PARTIAL',
        wallets: ['0xabc'],
        currentConsolidatedTdh: []
      })
    ).rejects.toThrow('persistence transaction failed');

    expect(mockPersistTdhBlock).not.toHaveBeenCalled();
    expect(mockSqsSendToQueueName).not.toHaveBeenCalled();
  });

  it('propagates a partial xTDH enqueue failure after persistence', async () => {
    mockSqsSendToQueueName.mockRejectedValueOnce(
      new Error('queue lookup failed')
    );

    await expect(
      consolidateAndPersistTDH(block, blockTimestamp, {
        mode: 'PARTIAL',
        wallets: ['0xabc'],
        currentConsolidatedTdh: []
      })
    ).rejects.toThrow('queue lookup failed');

    expect(mockPersistConsolidatedTdh).toHaveBeenCalledTimes(1);
    expect(mockPersistTdhBlock).toHaveBeenCalledTimes(1);
  });
});
