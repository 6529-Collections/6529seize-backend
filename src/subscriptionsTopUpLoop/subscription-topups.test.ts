import { getAlchemyInstance } from '@/alchemy';
import { SUBSCRIPTIONS_ADDRESS } from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import { discoverTopUps } from './subscription_topups';
import {
  getLatestSubscriptionTopUpBlock,
  persistLatestSubscriptionTopUpBlock,
  persistTopUps
} from './db.subscriptions_topup';

jest.mock('@/alchemy', () => ({ getAlchemyInstance: jest.fn() }));
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('./db.subscriptions_topup', () => ({
  getLatestSubscriptionTopUpBlock: jest.fn(),
  getMaxSubscriptionTopUpBlock: jest.fn(),
  persistLatestSubscriptionTopUpBlock: jest.fn(),
  persistTopUps: jest.fn()
}));

describe('subscription discovery with split providers', () => {
  const originalEnv = process.env;
  const getAssetTransfers = jest.fn();
  const getBlockNumber = jest.fn();
  const getBlock = jest.fn();
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, SUBSCRIPTIONS_CHAIN_ID: '1' };
    jest.mocked(getAlchemyInstance).mockReturnValue({
      core: { getAssetTransfers }
    } as unknown as ReturnType<typeof getAlchemyInstance>);
    jest.mocked(getEthereumRpcClient).mockReturnValue({
      getBlockNumber,
      getBlock
    } as unknown as ReturnType<typeof getEthereumRpcClient>);
    jest.mocked(getLatestSubscriptionTopUpBlock).mockResolvedValue(100);
    getBlockNumber.mockResolvedValue(110);
    getBlock.mockResolvedValue({ timestamp: 1234 });
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  function transfer(block: number, hash = '0xtx') {
    return {
      blockNum: '0x' + block.toString(16),
      hash,
      from: '0xABC',
      to: SUBSCRIPTIONS_ADDRESS,
      value: 2,
      metadata: { blockTimestamp: '2026-01-01T00:00:00Z' }
    };
  }

  it('paginates indexed results but uses ordinary RPC for the head and checkpoint timestamp', async () => {
    getAssetTransfers
      .mockResolvedValueOnce({
        transfers: [transfer(101), transfer(106)],
        pageKey: 'page-2'
      })
      .mockResolvedValueOnce({
        transfers: [transfer(101), transfer(102, '0xsecond')]
      });
    await discoverTopUps();
    expect(getAlchemyInstance).toHaveBeenCalledWith(Network.ETH_MAINNET);
    expect(getEthereumRpcClient).toHaveBeenCalledWith(Network.ETH_MAINNET);
    expect(getAssetTransfers).toHaveBeenCalledTimes(2);
    expect(getAssetTransfers).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fromBlock: '0x65',
        toBlock: '0x69',
        pageKey: 'page-2',
        withMetadata: true
      })
    );
    expect(persistTopUps).toHaveBeenCalledWith([
      expect.objectContaining({
        block: 101,
        hash: '0xtx',
        from_wallet: '0xabc',
        amount: 2
      }),
      expect.objectContaining({ block: 102, hash: '0xsecond' })
    ]);
    expect(getBlock).toHaveBeenCalledWith(105);
    expect(persistLatestSubscriptionTopUpBlock).toHaveBeenCalledWith(105, 1234);
  });

  it('does not advance the checkpoint when a later indexed page fails', async () => {
    getAssetTransfers
      .mockResolvedValueOnce({ transfers: [transfer(101)], pageKey: 'next' })
      .mockRejectedValueOnce(new Error('indexer unavailable'));
    await expect(discoverTopUps()).rejects.toThrow('indexer unavailable');
    expect(persistTopUps).not.toHaveBeenCalled();
    expect(persistLatestSubscriptionTopUpBlock).not.toHaveBeenCalled();
  });

  it('keeps the existing optional timestamp behavior if a checkpoint block read fails', async () => {
    getAssetTransfers.mockResolvedValue({ transfers: [] });
    getBlock.mockRejectedValue(new Error('block unavailable'));
    await discoverTopUps();
    expect(persistLatestSubscriptionTopUpBlock).toHaveBeenCalledWith(
      105,
      undefined
    );
  });

  it('selects Sepolia for both independent clients without using mainnet', async () => {
    process.env.SUBSCRIPTIONS_CHAIN_ID = '11155111';
    getAssetTransfers.mockResolvedValue({ transfers: [] });
    await discoverTopUps();
    expect(getEthereumRpcClient).toHaveBeenCalledWith(Network.ETH_SEPOLIA);
    expect(getAlchemyInstance).toHaveBeenCalledWith(Network.ETH_SEPOLIA);
  });

  it('rejects unsupported configured chains before creating either client', async () => {
    process.env.SUBSCRIPTIONS_CHAIN_ID = '560048';
    await expect(discoverTopUps()).rejects.toThrow(
      'Unsupported SUBSCRIPTIONS_CHAIN_ID'
    );
    expect(getEthereumRpcClient).not.toHaveBeenCalled();
    expect(getAlchemyInstance).not.toHaveBeenCalled();
  });

  it('never queries indexed pages or advances progress when the ordinary head fails', async () => {
    getBlockNumber.mockRejectedValue(new Error('RPC unavailable'));
    await expect(discoverTopUps()).rejects.toThrow('RPC unavailable');
    expect(getAssetTransfers).not.toHaveBeenCalled();
    expect(persistLatestSubscriptionTopUpBlock).not.toHaveBeenCalled();
  });
});
