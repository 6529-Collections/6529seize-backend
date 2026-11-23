import { fetchLatestNftHistoryBlockNumber } from '@/db';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { fetchNextGenLatestBlock } from '@/nextgen/nextgen.db';
import { RebuildContext } from '@/rebuild/manifest.types';
import { sqlExecutor } from '@/sql-executor';
import { rebuildWalletTransferAnalysis } from '@/wallet-transfer-analysis/wallet-transfer-rebuild';
import { catchUpHoldings } from './holdings-catch-up';
import { rebuildHoldings } from './holdings-seed';

jest.mock('@/db', () => ({
  fetchLatestNftHistoryBlockNumber: jest.fn(),
  getDataSource: () => ({ manager: {} })
}));
jest.mock('@/nextgen/nextgen.db', () => ({
  fetchNextGenLatestBlock: jest.fn()
}));
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('@/sql-executor', () => ({ sqlExecutor: { execute: jest.fn() } }));
jest.mock('./holdings-seed', () => ({ rebuildHoldings: jest.fn() }));
jest.mock('@/wallet-transfer-analysis/wallet-transfer-rebuild', () => ({
  rebuildWalletTransferAnalysis: jest.fn()
}));

const historyAt = fetchLatestNftHistoryBlockNumber as jest.Mock;
const nextGenAt = fetchNextGenLatestBlock as jest.Mock;
const getBlock = jest.fn();

function context(ethBlock: number | null): RebuildContext {
  return {
    area: 'holdings',
    stepId: 'holdings.catch-up',
    sources: {} as RebuildContext['sources'],
    seedFilesDir: null,
    mark: { name: 'head', chainHeight: null, ethBlock }
  };
}

describe('catchUpHoldings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getEthereumRpcClient as jest.Mock).mockReturnValue({ getBlock });
    getBlock.mockResolvedValue({ number: 37 });
    (sqlExecutor.execute as jest.Mock).mockResolvedValue([]);
  });

  it('writes nothing when NFT history and NextGen are at the finalized block', async () => {
    historyAt.mockResolvedValue(37);
    nextGenAt.mockResolvedValue(37);
    await catchUpHoldings(context(null));
    expect(getBlock).toHaveBeenCalledWith('finalized');
    expect(rebuildHoldings).not.toHaveBeenCalled();
    expect(rebuildWalletTransferAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    ['NFT history', 23, 37],
    ['NextGen', 37, 23],
    ['both', 23, 23]
  ])(
    'runs the holdings steps when %s is behind',
    async (_, history, nextGen) => {
      historyAt.mockResolvedValue(history);
      nextGenAt.mockResolvedValue(nextGen);
      const ctx = context(null);
      await catchUpHoldings(ctx);
      expect(rebuildHoldings).toHaveBeenCalledWith(ctx);
      expect(rebuildWalletTransferAnalysis).toHaveBeenCalledTimes(1);
    }
  );

  it("fails, without writing, when TDH's seed has already filled tdh_nft", async () => {
    historyAt.mockResolvedValue(23);
    nextGenAt.mockResolvedValue(23);
    (sqlExecutor.execute as jest.Mock).mockResolvedValue([{ found: 1 }]);
    await expect(catchUpHoldings(context(null))).rejects.toThrow(
      "TDH's seed ran before holdings.catch-up"
    );
    expect(rebuildHoldings).not.toHaveBeenCalled();
    expect(rebuildWalletTransferAnalysis).not.toHaveBeenCalled();
  });

  it('counts an empty history as behind', async () => {
    historyAt.mockResolvedValue(null);
    nextGenAt.mockResolvedValue(37);
    await catchUpHoldings(context(null));
    expect(rebuildHoldings).toHaveBeenCalledTimes(1);
  });

  it('catches up to the run mark, when there is one, without asking for the finalized block', async () => {
    historyAt.mockResolvedValue(37);
    nextGenAt.mockResolvedValue(37);
    await catchUpHoldings(context(37));
    expect(getBlock).not.toHaveBeenCalled();
    expect(rebuildHoldings).not.toHaveBeenCalled();

    await catchUpHoldings(context(40));
    expect(rebuildHoldings).toHaveBeenCalledTimes(1);
  });
});
