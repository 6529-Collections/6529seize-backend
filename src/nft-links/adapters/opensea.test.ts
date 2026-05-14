import { formatUnits } from 'ethers';
import fc from 'fast-check';
import { fetchJsonWithTimeout } from '../lib/http';
import { OpenSeaAdapter } from './opensea';
import { CanonicalLink } from '@/nft-links/types';

jest.mock('../lib/http', () => ({
  fetchJsonWithTimeout: jest.fn()
}));

const fetchJsonMock = fetchJsonWithTimeout as jest.MockedFunction<
  typeof fetchJsonWithTimeout
>;

const originalEnv = { ...process.env };

const canonical: CanonicalLink = {
  platform: 'OPENSEA',
  viewUrl:
    'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1',
  canonicalId: 'OPENSEA:eth:0x1111111111111111111111111111111111111111:1',
  identifiers: {
    kind: 'TOKEN',
    chain: 'eth',
    contract: '0x1111111111111111111111111111111111111111',
    tokenId: '1'
  },
  originalUrl:
    'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1'
};

function nftResponse() {
  return {
    nft: {
      name: 'Edition #1',
      image_url: 'https://example.com/image.png',
      collection: {
        name: 'Test Collection',
        slug: 'test-collection'
      }
    }
  };
}

function legacyOrder({
  currentPrice,
  quantity
}: {
  currentPrice: bigint;
  quantity: number;
}) {
  return {
    current_price: currentPrice.toString(),
    remaining_quantity: String(quantity),
    payment_token: {
      symbol: 'ETH'
    }
  };
}

async function resolveWithLegacyOrders(orders: any[]) {
  fetchJsonMock
    .mockResolvedValueOnce(nftResponse())
    .mockRejectedValueOnce(new Error('best listing unavailable'))
    .mockResolvedValueOnce({ orders });

  const result = await new OpenSeaAdapter().resolveFast(canonical);
  return (result?.patch as any).market.price;
}

describe('OpenSeaAdapter', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.OPENSEA_API_KEY = 'test-key';
    delete process.env.OPENSEA_API_BASE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('prefers the NFT-specific best listing endpoint', async () => {
    fetchJsonMock.mockResolvedValueOnce(nftResponse()).mockResolvedValueOnce({
      listing: {
        price: {
          current: {
            value: '50000000000000000',
            currency: 'ETH',
            decimals: 18
          }
        }
      }
    });

    const result = await new OpenSeaAdapter().resolveFast(canonical);
    const price = (result?.patch as any).market.price;

    expect(price).toEqual({
      amount: '0.05',
      currency: 'ETH'
    });
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    expect(fetchJsonMock.mock.calls[1]?.[0]).toContain(
      '/api/v2/listings/collection/test-collection/nfts/1/best'
    );
  });

  it('normalizes structured best listing aggregate price to unit price', async () => {
    fetchJsonMock.mockResolvedValueOnce(nftResponse()).mockResolvedValueOnce({
      listing: {
        quantity: 5,
        price: {
          current: {
            value: '250000000000000000',
            currency: 'ETH',
            decimals: 18
          }
        }
      }
    });

    const result = await new OpenSeaAdapter().resolveFast(canonical);
    const price = (result?.patch as any).market.price;

    expect(price).toEqual({
      amount: '0.05',
      currency: 'ETH'
    });
  });

  it('normalizes legacy ERC1155 aggregate price to unit price', async () => {
    const price = await resolveWithLegacyOrders([
      legacyOrder({
        currentPrice: BigInt('250000000000000000'),
        quantity: 5
      })
    ]);

    expect(price).toEqual({
      amount: '0.05',
      currency: 'ETH'
    });
  });

  it('chooses the lowest normalized unit price from legacy listings', async () => {
    const price = await resolveWithLegacyOrders([
      legacyOrder({
        currentPrice: BigInt('120000000000000000'),
        quantity: 2
      }),
      legacyOrder({
        currentPrice: BigInt('250000000000000000'),
        quantity: 5
      })
    ]);

    expect(price).toEqual({
      amount: '0.05',
      currency: 'ETH'
    });
  });

  it('keeps single quantity legacy listing price unchanged', async () => {
    const price = await resolveWithLegacyOrders([
      legacyOrder({
        currentPrice: BigInt('50000000000000000'),
        quantity: 1
      })
    ]);

    expect(price).toEqual({
      amount: '0.05',
      currency: 'ETH'
    });
  });

  it('normalizes generated legacy ERC1155 aggregate prices by quantity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000000 }),
        fc.integer({ min: 2, max: 25 }),
        async (unitWeiNumber, quantity) => {
          fetchJsonMock.mockReset();
          const unitWei = BigInt(unitWeiNumber);
          const totalWei = unitWei * BigInt(quantity);

          const price = await resolveWithLegacyOrders([
            legacyOrder({
              currentPrice: totalWei,
              quantity
            })
          ]);

          expect(price).toEqual({
            amount: formatUnits(unitWei, 18),
            currency: 'ETH'
          });
        }
      ),
      { numRuns: 25 }
    );
  });
});
