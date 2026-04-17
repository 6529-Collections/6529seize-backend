import {
  Alchemy,
  AssetTransfersCategory,
  Network,
  SortingOrder
} from '@/alchemy-sdk';

describe('Alchemy SDK replacement', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('calls alchemy_getAssetTransfers with expected params', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          transfers: [{ hash: '0xabc', blockNum: '0x1' }],
          pageKey: 'next'
        }
      })
    }) as unknown as typeof fetch;

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
    expect(global.fetch).toHaveBeenCalledWith(
      'https://eth-mainnet.g.alchemy.com/v2/test-key',
      expect.objectContaining({
        method: 'POST'
      })
    );
    const body = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string
    );
    expect(body.method).toBe('alchemy_getAssetTransfers');
    expect(body.params[0]).toEqual(
      expect.objectContaining({
        maxCount: 150,
        withMetadata: true
      })
    );
  });

  it('calls alchemy_getNFTMetadataBatch and returns nfts', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          nfts: [{ tokenId: '1' }, { tokenId: '2' }]
        }
      })
    }) as unknown as typeof fetch;

    const alchemy = new Alchemy({
      network: Network.ETH_SEPOLIA,
      apiKey: 'test-key'
    });

    const response = await alchemy.nft.getNftMetadataBatch([
      { contractAddress: '0xabc', tokenId: '1' },
      { contractAddress: '0xabc', tokenId: '2' }
    ]);

    expect(response.nfts).toHaveLength(2);
    const body = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string
    );
    expect(body.method).toBe('alchemy_getNFTMetadataBatch');
    expect(body.params).toEqual([
      [
        { contractAddress: '0xabc', tokenId: '1' },
        { contractAddress: '0xabc', tokenId: '2' }
      ]
    ]);
  });
});
