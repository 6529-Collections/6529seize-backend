import { MarketDepthApiDb } from './market-depth-api.db';
import { marketDepthDb } from '@/market-depth/market-depth.db';
import { SqlExecutor } from '@/sql-executor';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot,
  MAX_MARKET_DEPTH_COLLECTION_ASKS
} from '@/market-depth/market-depth.types';
import { MEMES_CONTRACT } from '@/constants';

jest.mock('@/market-depth/market-depth.db', () => ({
  marketDepthDb: { getLatestCompletedSnapshot: jest.fn() }
}));

const token = {
  contract: MEMES_CONTRACT.toLowerCase(),
  token_id: '1',
  collection_id: null
};
const emptyBook: CurrentMarketDepthSnapshot = {
  snapshot: {
    id: 'snapshot-1',
    source: 'opensea',
    contract: token.contract,
    chain: 'ethereum',
    chain_id: '1',
    collection_slug: 'collection',
    collection_id: null,
    schema_version: 1,
    normalizer_version: '1',
    started_at: new Date(),
    completed_at: new Date(),
    raw_order_count: 0,
    order_count: 0,
    ask_count: 0,
    bid_count: 0,
    unsupported_count: 0,
    skipped_count: 0,
    event_count: 0
  },
  orders: []
};

describe('bounded collection index reads', () => {
  afterEach(() => jest.restoreAllMocks());

  function fixture() {
    const db = new MarketDepthApiDb(
      () =>
        ({ execute: jest.fn().mockResolvedValue([]) }) as unknown as SqlExecutor
    );
    jest.spyOn(db, 'getPartitions').mockResolvedValue([
      { source: 'opensea', collection_slug: 'collection-a' },
      { source: 'opensea', collection_slug: 'collection-b' }
    ]);
    jest.mocked(marketDepthDb.getLatestCompletedSnapshot).mockReset();
    return db;
  }

  it.each([true, 'all'] as const)(
    'rejects a %s collection read when any expected partition is missing',
    async (scope) => {
      const db = fixture();
      jest
        .mocked(marketDepthDb.getLatestCompletedSnapshot)
        .mockResolvedValueOnce(emptyBook)
        .mockResolvedValueOnce(null);
      await expect(db.getBooks(token, scope)).rejects.toMatchObject({
        message: 'The indexed collection is temporarily unavailable.'
      });
    }
  );

  it('keeps both bid and ask terms within a bounded all-orders collection read', async () => {
    const db = fixture();
    jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mockResolvedValue(emptyBook);
    await expect(db.getBooks(token, 'all')).resolves.toHaveLength(2);
    for (const side of ['ask', 'bid'])
      expect(marketDepthDb.getLatestCompletedSnapshot).toHaveBeenCalledWith(
        'opensea',
        token.contract,
        'collection-a',
        { side, limit: 2500 }
      );
    const limits = jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mock.calls.map((call) => call[3]!.limit!);
    expect(limits.reduce((sum, limit) => sum + limit, 0)).toBe(
      MAX_MARKET_DEPTH_COLLECTION_ASKS
    );
  });

  it('retains bids when more than the entire collection bound is occupied by asks', async () => {
    const db = fixture();
    jest
      .spyOn(db, 'getPartitions')
      .mockResolvedValue([
        { source: 'opensea', collection_slug: 'collection-a' }
      ]);
    const orders = Array.from(
      { length: MAX_MARKET_DEPTH_COLLECTION_ASKS },
      (_, index) =>
        ({
          order_id: `ask-${index}`,
          side: 'ask',
          observed_at: new Date()
        }) as CurrentMarketDepthOrder
    );
    orders.push({
      order_id: 'bid',
      side: 'bid',
      observed_at: new Date()
    } as CurrentMarketDepthOrder);
    jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mockImplementation(async (_source, _contract, _slug, options) => ({
        snapshot: {
          ...emptyBook.snapshot,
          order_count: orders.length,
          ask_count: orders.length - 1,
          bid_count: 1
        },
        orders: orders
          .filter((order) => !options?.side || order.side === options.side)
          .slice(0, options?.limit)
      }));
    const result = await db.getBooks(token, 'all');
    expect(result[0].orders.some((order) => order.order_id === 'bid')).toBe(
      true
    );
    expect(result[0].orders).toHaveLength(
      MAX_MARKET_DEPTH_COLLECTION_ASKS / 2 + 1
    );
    expect(result[0].snapshot.order_count).toBe(orders.length);
    expect(result[0].orders.length).toBeLessThan(
      result[0].snapshot.order_count
    );
  });

  it('rejects combining sides from different snapshot generations', async () => {
    const db = fixture();
    jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mockResolvedValue(emptyBook)
      .mockResolvedValueOnce({
        ...emptyBook,
        snapshot: { ...emptyBook.snapshot, id: 'older' }
      });
    await expect(db.getBooks(token, 'all')).rejects.toThrow('updating');
  });

  it('preserves token-depth partial reads during a partition refresh', async () => {
    const db = fixture();
    jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mockResolvedValueOnce(emptyBook)
      .mockResolvedValueOnce(null);
    await expect(db.getBooks(token)).resolves.toEqual([emptyBook]);
  });

  it('retains complete empty partitions so no liquidity is an observed result', async () => {
    const db = fixture();
    jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mockResolvedValue(emptyBook);
    await expect(db.getBooks(token, true)).resolves.toHaveLength(2);
  });
});
