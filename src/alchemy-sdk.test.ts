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

import axios from 'axios';
import axiosRetry from 'axios-retry';
import { Alchemy, AssetTransfersCategory, SortingOrder } from '@/alchemy-sdk';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';

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

    it('exposes indexed methods only and requires no ordinary RPC configuration', () => {
      const previous = process.env.ETHEREUM_RPC_URL;
      delete process.env.ETHEREUM_RPC_URL;
      try {
        const client = new Alchemy({ apiKey: 'indexed-key' });
        expect(client.core).not.toHaveProperty('getBlock');
        expect(client.core).not.toHaveProperty('resolveName');
        expect(client.core.getAssetTransfers).toBeInstanceOf(Function);
      } finally {
        if (previous === undefined) delete process.env.ETHEREUM_RPC_URL;
        else process.env.ETHEREUM_RPC_URL = previous;
      }
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

    it('calls getNFTsForOwner with bracketed contract address params', async () => {
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
          paramsSerializer: { serialize: expect.any(Function) }
        })
      );

      const requestConfig = mockedAxios.get.mock.calls[0][1];
      const serialized = requestConfig.paramsSerializer.serialize(
        requestConfig.params
      );
      const searchParams = new URLSearchParams(serialized);
      expect(searchParams.getAll('contractAddresses[]')).toEqual([
        '0xa',
        '0xb'
      ]);
      expect(searchParams.has('contractAddresses')).toBe(false);
      expect(searchParams.get('owner')).toBe('0xowner');
      expect(searchParams.get('pageKey')).toBe('p1');
      expect(() =>
        requestConfig.paramsSerializer.serialize({ unsupported: {} })
      ).toThrow('Unsupported Alchemy NFT query parameter value');
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
