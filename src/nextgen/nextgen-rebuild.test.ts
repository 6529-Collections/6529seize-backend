import { getDataSource } from '@/db';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import {
  isRebuildingEthereumIndexes,
  whileRebuildingEthereumIndexes
} from '@/holdings/rebuild-mode';
import * as nextgenModule from './nextgen';
import { findNextGenTransactions } from './nextgen';
import { rebuildNextGen } from './nextgen-rebuild';
import { fetchNextGenLatestBlock } from './nextgen.db';
import { findCoreTransactions } from './nextgen_core_transactions';
import { processMissingThumbnails } from './nextgen_pending_thumbnails';
import { refreshNextgenTokens } from './nextgen_tokens';
import { getNextgenStartBlock } from './nextgen_constants';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/alchemy-sdk', () => ({ Alchemy: jest.fn() }));
jest.mock('@/ethereum-rpc/ethereum-rpc-client');
jest.mock('./nextgen.db');
jest.mock('./nextgen_core_events');
jest.mock('./nextgen_core_transactions');
jest.mock('./nextgen_minter');
jest.mock('./nextgen_pending_metadata');
jest.mock('./nextgen_pending_mint_data');
jest.mock('./nextgen_tokens');
jest.mock('./nextgen_pending_thumbnails');

const getBlockNumber = jest.fn();
const getBlock = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getDataSource).mockReturnValue({
    transaction: async (_isolation: string, action: (m: unknown) => unknown) =>
      action({})
  } as never);
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue({ getBlockNumber, getBlock } as never);
  getBlockNumber.mockResolvedValue(1_000);
  getBlock.mockResolvedValue({ number: 900, timestamp: 1_900 });
});

afterEach(() => jest.restoreAllMocks());

describe('the NextGen contract loop', () => {
  it('stops at the given block instead of the latest, and says it caught up', async () => {
    jest.mocked(fetchNextGenLatestBlock).mockResolvedValue(10);

    await expect(
      findNextGenTransactions(undefined, { toBlock: 500 })
    ).resolves.toEqual({ caughtUp: true });

    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(jest.mocked(findCoreTransactions).mock.calls[0].slice(2)).toEqual([
      10, 500
    ]);
    expect(refreshNextgenTokens).toHaveBeenCalled();
  });

  it('says a range cut at the block limit has not caught up, and leaves the rest for a later run', async () => {
    jest.mocked(fetchNextGenLatestBlock).mockResolvedValue(10);
    getBlockNumber.mockResolvedValue(500_000);

    await expect(findNextGenTransactions()).resolves.toEqual({
      caughtUp: false
    });

    expect(jest.mocked(findCoreTransactions).mock.calls[0].slice(2)).toEqual([
      10, 100_010
    ]);
    expect(refreshNextgenTokens).not.toHaveBeenCalled();
  });

  it('lists the media bucket for thumbnails outside rebuild mode only', async () => {
    jest.mocked(fetchNextGenLatestBlock).mockResolvedValue(10);

    await findNextGenTransactions();
    expect(processMissingThumbnails).toHaveBeenCalledTimes(1);

    await whileRebuildingEthereumIndexes(() => findNextGenTransactions());
    expect(processMissingThumbnails).toHaveBeenCalledTimes(1);
    expect(refreshNextgenTokens).toHaveBeenCalledTimes(2);
  });
});

describe('the NextGen start block', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it("is the core contract's deploy block unless NEXTGEN_START_BLOCK_OVERRIDE is set", () => {
    process.env = { ...env };
    delete process.env.NEXTGEN_START_BLOCK_OVERRIDE;
    expect(getNextgenStartBlock(Network.ETH_MAINNET)).toBe(19133749);

    process.env = { ...env, NEXTGEN_START_BLOCK_OVERRIDE: '0' };
    expect(getNextgenStartBlock(Network.ETH_MAINNET)).toBe(0);
  });

  it.each(['-1', '1.5', 'latest'])('refuses %s', (value) => {
    process.env = { ...env, NEXTGEN_START_BLOCK_OVERRIDE: value };
    expect(() => getNextgenStartBlock(Network.ETH_MAINNET)).toThrow(
      'NEXTGEN_START_BLOCK_OVERRIDE must be a block number'
    );
  });
});

describe('rebuildNextGen', () => {
  it('runs the loop in rebuild mode until a run reaches the mark', async () => {
    const modes: boolean[] = [];
    const runs = jest
      .spyOn(nextgenModule, 'findNextGenTransactions')
      .mockImplementation(async () => {
        modes.push(isRebuildingEthereumIndexes());
        return { caughtUp: modes.length === 3 };
      });

    await rebuildNextGen({ mark: { ethBlock: 777 } });

    expect(runs.mock.calls).toEqual([
      [undefined, { toBlock: 777 }],
      [undefined, { toBlock: 777 }],
      [undefined, { toBlock: 777 }]
    ]);
    expect(modes).toEqual([true, true, true]);
    expect(isRebuildingEthereumIndexes()).toBe(false);
  });

  it('runs to the finalized block when the run names no mark', async () => {
    const runs = jest
      .spyOn(nextgenModule, 'findNextGenTransactions')
      .mockResolvedValue({ caughtUp: true });

    await rebuildNextGen({ mark: { ethBlock: null } });

    expect(getBlock).toHaveBeenCalledWith('finalized');
    expect(runs.mock.calls).toEqual([[undefined, { toBlock: 900 }]]);
  });
});
