import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import {
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  findVolumesForContract,
  persistLabNFTS,
  persistNFTs
} from '@/db';
import { LabNFT, NFT } from '@/entities/INFT';
import { findNftMarketStats } from '@/marketStatsLoop/nft_market_stats';
import {
  fetchBestListingsForCollection,
  fetchBestOffersForCollection
} from '@/marketStatsLoop/nft_market_stats_prices';
import { Time } from '@/time';
import { getRedisClient } from '@/redis';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));

jest.mock('@/db', () => ({
  fetchAllMemeLabNFTs: jest.fn(),
  fetchNftsForContract: jest.fn(),
  findVolumesForContract: jest.fn(),
  persistLabNFTS: jest.fn(),
  persistNFTs: jest.fn()
}));

type Source = 'offers' | 'listings';
const sources: Source[] = ['offers', 'listings'];

function order(source: Source, tokenId: string, value: string) {
  const price = { value, decimals: 18, currency: 'ETH' };
  const items = [
    { identifierOrCriteria: tokenId, startAmount: '1', itemType: 3 }
  ];
  return {
    price: source === 'offers' ? price : { current: price },
    protocol_data: {
      parameters: {
        consideration: items,
        offer: items,
        offerer: `maker-${value}`
      }
    }
  };
}

function fetchPrices(source: Source, deadlineMs?: number) {
  return source === 'offers'
    ? fetchBestOffersForCollection('collection', 3, deadlineMs)
    : fetchBestListingsForCollection('collection', 3, deadlineMs);
}

describe('OpenSea price pagination and persistence', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let nft: NFT;
  let labNft: LabNFT;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getRedisClient).mockReturnValue(null);
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Time.prototype, 'sleep').mockResolvedValue();
    nft = Object.assign(new NFT(), {
      id: 1,
      contract: MEMES_CONTRACT,
      supply: 10,
      floor_price: 5,
      floor_price_from: 'old-seller',
      market_cap: 50,
      highest_offer: 3,
      highest_offer_from: 'old-buyer'
    });
    labNft = Object.assign(new LabNFT(), nft);
    jest.mocked(fetchNftsForContract).mockResolvedValue([nft]);
    jest.mocked(fetchAllMemeLabNFTs).mockResolvedValue([labNft]);
    jest.mocked(findVolumesForContract).mockResolvedValue(new Map());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(sources)(
    'combines complete %s pages and chooses the best price',
    async (source) => {
      fetchMock
        .mockResolvedValueOnce(
          Response.json({
            [source]: [order(source, '1', '1000000000000000000')],
            next: 'cursor /?'
          })
        )
        .mockResolvedValueOnce(
          Response.json({
            [source]: [
              order(source, '1', '2000000000000000000'),
              order(source, '2', '3000000000000000000')
            ],
            next: null
          })
        );

      const prices = await fetchPrices(source);

      expect(prices.size).toBe(2);
      expect(prices.get('1')?.price).toBe(source === 'offers' ? 2 : 1);
      expect(prices.get('2')?.price).toBe(3);
      expect(
        new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('next')
      ).toBe('cursor /?');
    }
  );

  it.each(sources)(
    'accepts a successful empty %s collection',
    async (source) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ [source]: [], next: null })
      );
      await expect(fetchPrices(source)).resolves.toEqual(new Map());
    }
  );

  it.each(sources)(
    'accepts an empty terminal cursor after complete %s results',
    async (source) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          [source]: [order(source, '1', '1000000000000000000')],
          next: ''
        })
      );

      await expect(fetchPrices(source)).resolves.toEqual(
        new Map([['1', { price: 1, maker: 'maker-1000000000000000000' }]])
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each(sources)(
    'rejects a failed later %s page instead of returning partial prices',
    async (source) => {
      fetchMock
        .mockResolvedValueOnce(
          Response.json({
            [source]: [order(source, '1', '1000000000000000000')],
            next: 'page2'
          })
        )
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      await expect(fetchPrices(source)).rejects.toThrow('next=page2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    null,
    {},
    { offers: null },
    { offers: {} },
    { offers: [], next: 123 }
  ])('rejects an invalid page payload: %j', async (payload) => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await expect(fetchBestOffersForCollection('collection', 3)).rejects.toThrow(
      'Invalid offers'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects missing listings on a successful HTTP response', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ next: null }));
    await expect(
      fetchBestListingsForCollection('collection', 3)
    ).rejects.toThrow('Invalid listings');
  });

  it('rejects repeated cursors instead of silently completing or looping', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ offers: [], next: 'repeated' })
    );
    await expect(fetchBestOffersForCollection('collection', 3)).rejects.toThrow(
      'Repeated pagination cursor'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops before another page when rate limiting exceeds the deadline', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ offers: [], next: 'page2' })
    );
    await expect(fetchPrices('offers', Date.now() + 500)).rejects.toThrow(
      'deadline exceeded'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe.each([MEMES_CONTRACT, MEMELAB_CONTRACT, GRADIENT_CONTRACT])(
    'preserving stored stats for %s',
    (contract) => {
      it.each(sources)(
        'does not mutate or persist prices when a later %s page fails',
        async (source) => {
          if (source === 'listings') {
            fetchMock.mockResolvedValueOnce(
              Response.json({ offers: [], next: null })
            );
          }
          fetchMock
            .mockResolvedValueOnce(
              Response.json({
                [source]: [order(source, '1', '1000000000000000000')],
                next: 'page2'
              })
            )
            .mockResolvedValueOnce(new Response('failure', { status: 403 }));
          const originalNft = { ...nft };
          const originalLabNft = { ...labNft };

          await expect(findNftMarketStats(contract)).rejects.toThrow(
            'HTTP 403'
          );

          expect(persistNFTs).not.toHaveBeenCalled();
          expect(persistLabNFTS).not.toHaveBeenCalled();
          expect(fetchNftsForContract).not.toHaveBeenCalled();
          expect(fetchAllMemeLabNFTs).not.toHaveBeenCalled();
          expect(nft).toEqual(originalNft);
          expect(labNft).toEqual(originalLabNft);
        }
      );
    }
  );

  it('preserves prices when retries on a later listings page are exhausted', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ offers: [], next: null }))
      .mockResolvedValueOnce(Response.json({ listings: [], next: 'page2' }))
      .mockImplementation(
        async () => new Response('unavailable', { status: 503 })
      );

    await expect(findNftMarketStats(MEMES_CONTRACT)).rejects.toThrow(
      'after 4 attempt(s)'
    );
    expect(persistNFTs).not.toHaveBeenCalled();
    expect(nft.floor_price).toBe(5);
    expect(nft.highest_offer).toBe(3);
  });

  it('shares the fetch deadline between offers and listings', async () => {
    const now = Date.now();
    const nowMock = jest.spyOn(Date, 'now').mockReturnValue(now);
    fetchMock.mockImplementationOnce(async () => {
      nowMock.mockReturnValue(now + 600001);
      return Response.json({ offers: [], next: null });
    });

    await expect(findNftMarketStats(MEMES_CONTRACT)).rejects.toThrow(
      'deadline exceeded'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persistNFTs).not.toHaveBeenCalled();
  });

  it('refreshes a large collection within the four-minute legacy budget', async () => {
    let now = Date.now();
    const startedAt = now;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(Time.prototype, 'sleep').mockImplementation(async function (
      this: Time
    ) {
      now += this.toMillis();
    });
    const pages = { offers: 40, listings: 30 };
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const source = url.pathname.includes('/offers/') ? 'offers' : 'listings';
      const page = Number(url.searchParams.get('next') ?? 0);
      now += 50;
      return Response.json({
        [source]: [
          order(
            source,
            '1',
            source === 'offers' ? '1000000000000000000' : '2000000000000000000'
          )
        ],
        next: page + 1 < pages[source] ? String(page + 1) : null
      });
    });

    await findNftMarketStats(MEMES_CONTRACT, startedAt + 4 * 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(70);
    expect(now - startedAt).toBeLessThan(4 * 60_000);
    expect(persistNFTs).toHaveBeenCalledWith([
      expect.objectContaining({
        floor_price: 2,
        highest_offer: 1,
        market_cap: 20
      })
    ]);
  });

  it('preserves stored prices when the shared quota exhausts the refresh budget', async () => {
    const acquire = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValue(60_000);
    jest
      .mocked(getRedisClient)
      .mockReturnValue({ eval: acquire } as unknown as ReturnType<
        typeof getRedisClient
      >);
    fetchMock.mockResolvedValueOnce(
      Response.json({ offers: [], next: 'page2' })
    );

    await expect(
      findNftMarketStats(MEMES_CONTRACT, Date.now() + 1000)
    ).rejects.toThrow('deadline exceeded');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persistNFTs).not.toHaveBeenCalled();
    expect(nft.floor_price).toBe(5);
    expect(nft.highest_offer).toBe(3);
  });

  it('clears old prices only after both complete collections are successfully empty', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ offers: [], next: null }))
      .mockResolvedValueOnce(Response.json({ listings: [], next: null }));

    await findNftMarketStats(MEMES_CONTRACT);

    expect(persistNFTs).toHaveBeenCalledWith([
      expect.objectContaining({
        floor_price: 0,
        floor_price_from: null,
        highest_offer: 0,
        highest_offer_from: null,
        market_cap: 0
      })
    ]);
  });

  it('persists complete prices after a transient fetch failure recovers', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          offers: [order('offers', '1', '1000000000000000000')],
          next: null
        })
      )
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNRESET' }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          listings: [order('listings', '1', '2000000000000000000')],
          next: null
        })
      );

    await findNftMarketStats(MEMES_CONTRACT);

    expect(persistNFTs).toHaveBeenCalledTimes(1);
    expect(persistNFTs).toHaveBeenCalledWith([
      expect.objectContaining({
        floor_price: 2,
        highest_offer: 1,
        market_cap: 20
      })
    ]);
  });
});
