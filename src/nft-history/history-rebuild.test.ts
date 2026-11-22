import { Alchemy } from '@/alchemy-sdk';
import { persistNftHistoryBlock } from '@/db';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import {
  findHistoryBlocks,
  rebuildNftHistory,
  rebuildNftHistoryStep
} from './history-rebuild';
import { historyLogFilters } from './history-transactions';
import { ingestHistorySources } from './source-replay';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('@/alchemy-sdk', () => ({
  ...jest.requireActual('@/alchemy-sdk'),
  Alchemy: jest.fn()
}));
jest.mock('@/db', () => ({ persistNftHistoryBlock: jest.fn() }));
jest.mock('./source-replay', () => ({ ingestHistorySources: jest.fn() }));

const getLogs = jest.fn();
const getBlock = jest.fn();
const getAssetTransfers = jest.fn();

/** Logs per filter (by its index), each at the given blocks. */
function logsAt(byFilter: number[][], refuseWiderThan = Infinity) {
  const filters = historyLogFilters();
  getLogs.mockImplementation(async (query) => {
    const from = parseInt(query.fromBlock, 16);
    const to = parseInt(query.toBlock, 16);
    if (to - from + 1 > refuseWiderThan) throw new Error('too many results');
    const index = filters.findIndex(
      (filter) =>
        JSON.stringify(filter.topics) === JSON.stringify(query.topics) &&
        JSON.stringify(filter.address) === JSON.stringify(query.address)
    );
    return (byFilter[index] ?? [])
      .filter((block) => block >= from && block <= to)
      .map((block) => ({ blockNumber: block, removed: false }));
  });
}

describe('NFT history rebuild', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(getEthereumRpcClient)
      .mockReturnValue({ getLogs, getBlock } as never);
    jest
      .mocked(Alchemy)
      .mockImplementation(() => ({ core: { getAssetTransfers } }) as never);
    getAssetTransfers.mockResolvedValue({ transfers: [] });
  });

  it('finds every block with a source, in wide ranges, sorted and once each', async () => {
    logsAt([[1_500_000, 20], [20, 2_100_000], [7]]);
    getAssetTransfers
      .mockResolvedValueOnce({
        transfers: [{ blockNum: '0x63' }],
        pageKey: 'next'
      })
      .mockResolvedValueOnce({ transfers: [{ blockNum: '0x64' }] })
      .mockResolvedValueOnce({ transfers: [] });

    const blocks = await findHistoryBlocks(0, 2_500_000);

    expect(blocks).toEqual([7, 20, 99, 100, 1_500_000, 2_100_000]);
    // Three filters, three ranges of a million blocks each.
    expect(getLogs).toHaveBeenCalledTimes(9);
    expect(getAssetTransfers).toHaveBeenCalledTimes(3);
    expect(getAssetTransfers.mock.calls[1][0]).toMatchObject({
      pageKey: 'next'
    });
  });

  it('halves a range the provider refuses', async () => {
    logsAt([[10, 999_999], [], []], 300_000);

    expect(await findHistoryBlocks(0, 999_999)).toEqual([10, 999_999]);
  });

  it('fails on a single block the provider still refuses', async () => {
    getLogs.mockRejectedValue(new Error('provider down'));
    await expect(findHistoryBlocks(5, 5)).rejects.toThrow('provider down');
  });

  it("ingests each source block in order with the loop's own code, then moves the checkpoint to the mark", async () => {
    logsAt([[30, 10], [], [20]]);

    const result = await rebuildNftHistory({ toBlock: 40 });

    expect(result).toEqual({ fromBlock: 0, toBlock: 40, sourceBlocks: 3 });
    expect(
      jest
        .mocked(ingestHistorySources)
        .mock.calls.map(([from, to]) => [from, to])
    ).toEqual([
      [10, 10],
      [20, 20],
      [30, 30]
    ]);
    expect(jest.mocked(ingestHistorySources).mock.calls[0][3]).toBe(
      persistNftHistoryBlock
    );
    expect(persistNftHistoryBlock).toHaveBeenLastCalledWith(40);
  });

  it("rebuilds to the run's Ethereum mark, else to the finalized block", async () => {
    logsAt([[], [], []]);
    getBlock.mockResolvedValue({ number: 77 });

    await rebuildNftHistoryStep({ mark: { ethBlock: 55 } });
    expect(persistNftHistoryBlock).toHaveBeenLastCalledWith(55);
    expect(getBlock).not.toHaveBeenCalled();

    await rebuildNftHistoryStep({ mark: { ethBlock: null } });
    expect(getBlock).toHaveBeenCalledWith('finalized');
    expect(persistNftHistoryBlock).toHaveBeenLastCalledWith(77);
  });
});
