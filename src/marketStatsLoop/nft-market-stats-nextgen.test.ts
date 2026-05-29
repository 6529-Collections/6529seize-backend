import { NEXTGEN_ROYALTIES_ADDRESS } from '../nextgen/nextgen_constants';
import {
  fetchOpenSeaCollectionListings,
  getOpenSeaCollectionSlug,
  getOpenSeaListingStats,
  indexBestOpenSeaListingsByTokenId,
  OpenSeaListing
} from './nft_market_stats_nextgen';

const fetchMock = jest.fn();
const originalFetch = global.fetch;

function jsonResponse(
  body: unknown,
  options: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    text?: string;
  } = {}
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(options.text ?? JSON.stringify(body))
  } as unknown as Response;
}

function listing(
  tokenId: string,
  priceWei: string,
  orderHash: string
): OpenSeaListing {
  return {
    price: {
      current: {
        decimals: 18,
        value: priceWei
      }
    },
    protocol_data: {
      parameters: {
        offer: [
          {
            identifierOrCriteria: tokenId
          }
        ]
      }
    },
    order_hash: orderHash
  } as OpenSeaListing;
}

describe('NextGen OpenSea market stats helpers', () => {
  beforeEach(() => {
    process.env.OPENSEA_API_KEY = 'opensea-key';
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    delete process.env.OPENSEA_API_KEY;
  });

  it('resolves the OpenSea collection slug from the contract endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ collection: 'pebbles-by-zeblocks' })
    );

    await expect(getOpenSeaCollectionSlug('0xabc')).resolves.toBe(
      'pebbles-by-zeblocks'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.opensea.io/api/v2/chain/ethereum/contract/0xabc',
      {
        headers: {
          accept: 'application/json',
          'x-api-key': 'opensea-key'
        }
      }
    );
  });

  it('fetches all paginated OpenSea collection listings', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          listings: [listing('1', '1000000000000000000', 'first')],
          next: 'cursor-1'
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          listings: [listing('2', '2000000000000000000', 'second')],
          next: null
        })
      );

    const listings = await fetchOpenSeaCollectionListings(
      'pebbles-by-zeblocks'
    );

    expect(listings).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(firstUrl.pathname).toBe(
      '/api/v2/listings/collection/pebbles-by-zeblocks/all'
    );
    expect(firstUrl.searchParams.get('limit')).toBe('200');
    expect(firstUrl.searchParams.has('next')).toBe(false);

    const secondUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(secondUrl.searchParams.get('limit')).toBe('200');
    expect(secondUrl.searchParams.get('next')).toBe('cursor-1');
  });

  it('indexes the lowest positive OpenSea listing price by token id', () => {
    const listings = [
      listing('1', '3000000000000000000', 'expensive'),
      listing('1', '1000000000000000000', 'cheap'),
      listing('2', '0', 'invalid'),
      listing('2', '2000000000000000000', 'valid')
    ];

    const indexed = indexBestOpenSeaListingsByTokenId(listings);

    expect(indexed.get('1')).toEqual(listings[1]);
    expect(indexed.get('2')).toEqual(listings[3]);
  });

  it('extracts listing stats from the new OpenSea response shape', () => {
    const stats = getOpenSeaListingStats({
      price: {
        current: {
          decimals: 18,
          value: '1000000000000000000'
        }
      },
      protocol_data: {
        parameters: {
          consideration: [
            {
              recipient: NEXTGEN_ROYALTIES_ADDRESS,
              startAmount: '25000000000000000'
            }
          ],
          endTime: '456',
          startTime: '123'
        }
      }
    });

    expect(stats).toEqual({
      expirationTime: 456,
      listingTime: 123,
      price: 1,
      royalty: 2.5
    });
  });

  it('extracts legacy maker fee royalty data when present', () => {
    const stats = getOpenSeaListingStats({
      current_price: '1000000000000000000',
      expiration_time: 456,
      listing_time: 123,
      maker_fees: [
        {
          account: {
            address: NEXTGEN_ROYALTIES_ADDRESS.toLowerCase()
          },
          basis_points: 750
        }
      ]
    });

    expect(stats).toEqual({
      expirationTime: 456,
      listingTime: 123,
      price: 1,
      royalty: 7.5
    });
  });

  it('throws for OpenSea failures instead of returning an empty listing set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'server failed' },
        { ok: false, status: 500, statusText: 'Server Error', text: 'failed' }
      )
    );

    await expect(fetchOpenSeaCollectionListings('slug')).rejects.toThrow(
      '[OPENSEA ERROR] 500 Server Error: failed'
    );
  });
});
