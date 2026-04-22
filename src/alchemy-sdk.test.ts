jest.mock('axios-retry', () => {
  const fn: any = jest.fn();
  fn.exponentialDelay = jest.fn(() => 0);
  fn.isNetworkError = jest.fn(() => false);
  fn.isRetryableError = jest.fn(() => false);
  return { __esModule: true, default: fn };
});

jest.mock('axios', () => {
  class MockAxiosError extends Error {
    response?: { status?: number; data?: unknown };
    constructor(message: string) {
      super(message);
      Object.setPrototypeOf(this, MockAxiosError.prototype);
    }
  }
  const mock: any = {
    get: jest.fn(),
    post: jest.fn(),
    AxiosError: MockAxiosError
  };
  mock.create = jest.fn(() => mock);
  return { __esModule: true, default: mock, AxiosError: MockAxiosError };
});

const mockProviderInstances: Array<{
  getBlockNumber: jest.Mock;
  getBlock: jest.Mock;
  getTransaction: jest.Mock;
  getTransactionReceipt: jest.Mock;
  getLogs: jest.Mock;
  resolveName: jest.Mock;
}> = [];

jest.mock('ethers', () => {
  class MockJsonRpcProvider {
    public readonly getBlockNumber = jest.fn();
    public readonly getBlock = jest.fn();
    public readonly getTransaction = jest.fn();
    public readonly getTransactionReceipt = jest.fn();
    public readonly getLogs = jest.fn();
    public readonly resolveName = jest.fn();

    constructor() {
      mockProviderInstances.push(this);
    }
  }

  return {
    __esModule: true,
    JsonRpcProvider: MockJsonRpcProvider
  };
});

import axios from 'axios';
import axiosRetry from 'axios-retry';
import {
  Alchemy,
  AssetTransfersCategory,
  Network,
  SortingOrder
} from '@/alchemy-sdk';

const mockedAxios = axios as unknown as jest.Mocked<typeof axios> & {
  get: jest.Mock;
  post: jest.Mock;
  create: jest.Mock;
};

describe('Alchemy SDK replacement', () => {
  afterEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
  });

  describe('retry configuration', () => {
    it('creates a dedicated axios instance with axios-retry configured', () => {
      // Each Alchemy instance owns its own axios client configured with
      // axios-retry in the constructor.
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { result: { transfers: [] } }
      });
      return new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      }).core
        .getAssetTransfers({
          category: [AssetTransfersCategory.EXTERNAL]
        })
        .then(() => {
          expect(mockedAxios.create).toHaveBeenCalled();
          expect(mockedAxios.create).toHaveBeenCalledWith(
            expect.objectContaining({
              headers: { 'Content-Type': 'application/json' },
              timeout: 30000
            })
          );
          expect(axiosRetry).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              retries: 3,
              retryDelay: expect.any(Function),
              retryCondition: expect.any(Function),
              shouldResetTimeout: true
            })
          );
        });
    });

    it('honors custom retry and timeout settings', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { result: { transfers: [] } }
      });

      await new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key',
        maxRetries: 7,
        timeoutMs: 7000
      }).core.getAssetTransfers({
        category: [AssetTransfersCategory.EXTERNAL]
      });

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 7000 })
      );
      expect(axiosRetry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ retries: 7 })
      );
    });
  });

  describe('core', () => {
    it('calls alchemy_getAssetTransfers as JSON-RPC', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          result: {
            transfers: [{ hash: '0xabc', blockNum: '0x1' }],
            pageKey: 'next'
          }
        }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      });

      const result = await alchemy.core.getAssetTransfers({
        category: [AssetTransfersCategory.EXTERNAL],
        order: SortingOrder.ASCENDING,
        maxCount: 150,
        withMetadata: true
      });

      expect(result.pageKey).toBe('next');
      expect(result.transfers).toHaveLength(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://eth-mainnet.g.alchemy.com/v2/test-key',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'alchemy_getAssetTransfers',
          params: [
            expect.objectContaining({
              maxCount: '0x96',
              withMetadata: true
            })
          ]
        }),
        expect.any(Object)
      );
    });

    it('rethrows JSON-RPC in-band errors with status/code', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          error: { message: 'bad params', code: -32602 }
        }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      });

      await expect(
        alchemy.core.getAssetTransfers({
          category: [AssetTransfersCategory.EXTERNAL]
        })
      ).rejects.toMatchObject({ message: 'bad params', code: -32602 });
    });

    it('retries provider-backed core calls using maxRetries', async () => {
      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'provider-retry-key',
        maxRetries: 2
      });
      const provider = mockProviderInstances.at(-1)!;
      const rateLimitError = Object.assign(new Error('Too many requests'), {
        status: 429
      });

      provider.getBlockNumber
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(123);

      await expect(alchemy.core.getBlockNumber()).resolves.toBe(123);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(2);
    });
  });

  describe('nft', () => {
    it('calls getNFTMetadata as REST GET with query params', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { tokenId: '1', contract: { address: '0xabc' } }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      });

      const result = await alchemy.nft.getNftMetadata('0xabc', '1', {
        refreshCache: true
      });

      expect(result.tokenId).toBe('1');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://eth-mainnet.g.alchemy.com/nft/v3/test-key/getNFTMetadata',
        expect.objectContaining({
          params: expect.objectContaining({
            contractAddress: '0xabc',
            tokenId: '1',
            refreshCache: true
          })
        })
      );
    });

    it('calls getContractMetadata as REST GET', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { address: '0xabc', name: 'Memes' }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      });

      const result = await alchemy.nft.getContractMetadata('0xabc');

      expect(result.name).toBe('Memes');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://eth-mainnet.g.alchemy.com/nft/v3/test-key/getContractMetadata',
        expect.objectContaining({
          params: { contractAddress: '0xabc' }
        })
      );
    });

    it('calls searchContractMetadata as REST GET', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { contracts: [{ address: '0xabc', name: 'Memes' }] }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      });

      const result = await alchemy.nft.searchContractMetadata('memes');

      expect(result).toEqual([{ address: '0xabc', name: 'Memes' }]);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://eth-mainnet.g.alchemy.com/nft/v3/test-key/searchContractMetadata',
        expect.objectContaining({
          params: { query: 'memes' }
        })
      );
    });

    it('calls getNFTsForOwner as REST GET with repeated array params', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { ownedNfts: [], totalCount: 0 }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_MAINNET,
        apiKey: 'test-key'
      });

      await alchemy.nft.getNftsForOwner('0xowner', {
        contractAddresses: ['0xa', '0xb'],
        pageKey: 'p1'
      });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://eth-mainnet.g.alchemy.com/nft/v3/test-key/getNFTsForOwner',
        expect.objectContaining({
          params: expect.objectContaining({
            owner: '0xowner',
            contractAddresses: ['0xa', '0xb'],
            pageKey: 'p1'
          }),
          paramsSerializer: { indexes: null }
        })
      );
    });

    it('calls getNFTMetadataBatch as REST POST', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { nfts: [{ tokenId: '1' }, { tokenId: '2' }] }
      });

      const alchemy = new Alchemy({
        network: Network.ETH_SEPOLIA,
        apiKey: 'test-key'
      });

      const response = await alchemy.nft.getNftMetadataBatch([
        { contractAddress: '0xabc', tokenId: '1' },
        { contractAddress: '0xabc', tokenId: '2' }
      ]);

      expect(response.nfts).toHaveLength(2);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://eth-sepolia.g.alchemy.com/nft/v3/test-key/getNFTMetadataBatch',
        {
          tokens: [
            { contractAddress: '0xabc', tokenId: '1' },
            { contractAddress: '0xabc', tokenId: '2' }
          ]
        },
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });
  });
});
