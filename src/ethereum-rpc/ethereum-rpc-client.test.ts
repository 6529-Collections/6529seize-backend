import { JsonRpcProvider } from 'ethers';
import { EthereumRpcClient, getEthereumRpcClient } from './ethereum-rpc-client';
import { Network } from './ethereum-rpc-network';
import { getEthereumRpcProvider } from './ethereum-rpc-provider';

jest.mock('axios-retry', () => ({
  __esModule: true,
  default: { exponentialDelay: () => 0 }
}));

describe('provider-neutral standard RPC client', () => {
  const originalEnv = process.env;
  let provider: JsonRpcProvider;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ETHEREUM_RPC_URL: 'https://rpc.example.test'
    };
    delete process.env.ALCHEMY_API_KEY;
    provider = getEthereumRpcProvider();
  });
  afterEach(() => {
    provider.destroy();
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('performs all standard reads through the configured provider without an Alchemy key', async () => {
    const block = {
      number: 4,
      hash: '0xblock',
      parentHash: '0xparent',
      timestamp: 123,
      nonce: '0x00',
      difficulty: BigInt(1),
      gasLimit: BigInt(5),
      gasUsed: BigInt(2),
      miner: '0xminer',
      extraData: '0x',
      baseFeePerGas: BigInt(2),
      transactions: ['0xtx']
    };
    const log = {
      blockNumber: 4,
      blockHash: '0xblock',
      transactionIndex: 0,
      transactionHash: '0xtx',
      address: '0xcontract',
      data: '0x',
      topics: ['0xtopic'],
      index: 7,
      removed: false
    };
    jest.spyOn(provider, 'getBlockNumber').mockResolvedValue(4);
    jest.spyOn(provider, 'getBlock').mockResolvedValue(block as never);
    jest.spyOn(provider, 'getTransaction').mockResolvedValue(null);
    jest.spyOn(provider, 'getTransactionReceipt').mockResolvedValue(null);
    jest.spyOn(provider, 'getLogs').mockResolvedValue([log] as never);
    jest.spyOn(provider, 'resolveName').mockResolvedValue(null);
    const client = getEthereumRpcClient();
    expect(await client.getBlockNumber()).toBe(4);
    expect(await client.getBlock('0x4')).toEqual(block);
    expect(await client.getTransaction('0xtx')).toBeNull();
    expect(await client.getTransactionReceipt('0xtx')).toBeNull();
    const filter = { fromBlock: '0x1', toBlock: '0x4' };
    expect(await client.getLogs(filter)).toEqual([
      { ...log, index: undefined, logIndex: 7 }
    ]);
    expect(provider.getLogs).toHaveBeenCalledWith(filter);
    expect(await client.resolveName('missing.eth')).toBeNull();
    expect(provider._getConnection().url).toBe('https://rpc.example.test');
  });

  it('keeps missing-block errors and bigint transaction/receipt values', async () => {
    jest.spyOn(provider, 'getBlock').mockResolvedValue(null);
    const tx = { value: BigInt('9007199254740993') };
    const receipt = { gasUsed: BigInt('9007199254740994') };
    jest.spyOn(provider, 'getTransaction').mockResolvedValue(tx as never);
    jest
      .spyOn(provider, 'getTransactionReceipt')
      .mockResolvedValue(receipt as never);
    const client = getEthereumRpcClient();
    await expect(client.getBlock(99)).rejects.toThrow('Block 99 not found');
    expect(await client.getTransaction('0xtx')).toBe(tx);
    expect(await client.getTransactionReceipt('0xtx')).toBe(receipt);
  });

  it('retries transient failures up to the configured limit', async () => {
    const error = Object.assign(new Error('rate limit'), { status: 429 });
    const read = jest
      .spyOn(provider, 'getBlockNumber')
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(10);
    const client = new EthereumRpcClient(Network.ETH_MAINNET, 2);
    await expect(client.getBlockNumber()).resolves.toBe(10);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockReset().mockRejectedValue(error);
    await expect(client.getBlockNumber()).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent failures or hide missing configuration behind Alchemy', async () => {
    const error = Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION'
    });
    const read = jest
      .spyOn(provider, 'getBlockNumber')
      .mockRejectedValue(error);
    await expect(getEthereumRpcClient().getBlockNumber()).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    delete process.env.ETHEREUM_RPC_URL;
    process.env.ALCHEMY_API_KEY = 'must-not-be-used';
    await expect(getEthereumRpcClient().getBlockNumber()).rejects.toThrow(
      'ETHEREUM_RPC_URL'
    );
  });

  it('fails immediately for a wrong-chain endpoint instead of retrying a configuration error', async () => {
    const error = Object.assign(new Error('network changed'), {
      code: 'NETWORK_ERROR',
      event: 'changed'
    });
    const read = jest
      .spyOn(provider, 'getBlockNumber')
      .mockRejectedValue(error);
    await expect(getEthereumRpcClient().getBlockNumber()).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('selects testnet explicitly and rejects unsupported networks', async () => {
    process.env.ETHEREUM_SEPOLIA_RPC_URL = 'https://sepolia.example.test';
    const testnet = getEthereumRpcProvider(11155111);
    try {
      jest.spyOn(testnet, 'getBlockNumber').mockResolvedValue(8);
      await expect(
        getEthereumRpcClient(Network.ETH_SEPOLIA).getBlockNumber()
      ).resolves.toBe(8);
      expect(testnet._getConnection().url).toBe('https://sepolia.example.test');
      await expect(
        getEthereumRpcClient('unknown' as Network).getBlockNumber()
      ).rejects.toThrow('Unsupported Ethereum RPC network');
    } finally {
      testnet.destroy();
    }
  });
});
