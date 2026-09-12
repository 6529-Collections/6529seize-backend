import { MarketDepthApiDb } from './market-depth-api.db';
import { marketDepthDb } from '@/market-depth/market-depth.db';
import { SqlExecutor } from '@/sql-executor';
import { CurrentMarketDepthSnapshot } from '@/market-depth/market-depth.types';
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
    const db = new MarketDepthApiDb(() => ({}) as SqlExecutor);
    jest.spyOn(db, 'getPartitions').mockResolvedValue([
      { source: 'opensea', collection_slug: 'collection-a' },
      { source: 'opensea', collection_slug: 'collection-b' }
    ]);
    jest.mocked(marketDepthDb.getLatestCompletedSnapshot).mockReset();
    return db;
  }

  it('rejects a collection read when any expected partition is missing', async () => {
    const db = fixture();
    jest
      .mocked(marketDepthDb.getLatestCompletedSnapshot)
      .mockResolvedValueOnce(emptyBook)
      .mockResolvedValueOnce(null);
    await expect(db.getBooks(token, true)).rejects.toMatchObject({
      message: 'The indexed collection is temporarily unavailable.'
    });
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
