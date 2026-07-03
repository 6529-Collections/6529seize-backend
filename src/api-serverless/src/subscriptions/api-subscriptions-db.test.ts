import * as dbApi from '@/db-api';
import * as nftsDb from '@/nftsLoop/db.nfts';
import {
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_MINT_PRICE,
  NFTS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  fetchPastMemeSubscriptionCounts,
  fetchRedeemedMemeSubscriptionCountsDownload,
  fetchUpcomingMemeSubscriptionCounts
} from './api.subscriptions.db';

describe('fetchPastMemeSubscriptionCounts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sums redeemed subscription counts instead of counting redeemed rows', async () => {
    const expectedResult = {
      count: 1,
      page: 2,
      next: null,
      data: []
    };
    const fetchPaginatedSpy = jest
      .spyOn(dbApi, 'fetchPaginated')
      .mockResolvedValue(expectedResult);

    await expect(fetchPastMemeSubscriptionCounts(20, 2)).resolves.toBe(
      expectedResult
    );

    expect(fetchPaginatedSpy).toHaveBeenCalledTimes(1);

    const fields = fetchPaginatedSpy.mock.calls[0][6] as string;
    const joins = fetchPaginatedSpy.mock.calls[0][7] as string;

    expect(fields).toContain(
      `COALESCE(SUM(${SUBSCRIPTIONS_REDEEMED_TABLE}.count), 0) AS count`
    );
    expect(fields).not.toContain(
      `COUNT(${SUBSCRIPTIONS_REDEEMED_TABLE}.consolidation_key)`
    );
    expect(joins).toContain(`LEFT JOIN ${SUBSCRIPTIONS_REDEEMED_TABLE}`);
    expect(joins).toContain(`LEFT JOIN ${MEMES_EXTENDED_DATA_TABLE}`);

    expect(fetchPaginatedSpy).toHaveBeenCalledWith(
      NFTS_TABLE,
      { startId: 220, contract: MEMES_CONTRACT },
      `${NFTS_TABLE}.id DESC`,
      20,
      2,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      `${NFTS_TABLE}.contract, ${NFTS_TABLE}.id`,
      { skipJoinsOnCountQuery: false }
    );
  });
});

describe('fetchUpcomingMemeSubscriptionCounts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps card_count behavior based on the next meme IDs', async () => {
    jest.spyOn(nftsDb, 'getMaxMemeId').mockResolvedValue(516);
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(fetchUpcomingMemeSubscriptionCounts(2)).resolves.toEqual([
      { contract: MEMES_CONTRACT, token_id: 517, count: 0 },
      { contract: MEMES_CONTRACT, token_id: 518, count: 0 }
    ]);

    expect(executeSpy).toHaveBeenNthCalledWith(
      1,
      `SELECT * FROM ${SUBSCRIPTIONS_MODE_TABLE} WHERE automatic = :automatic`,
      { automatic: true }
    );
    expect(executeSpy).toHaveBeenNthCalledWith(
      2,
      `SELECT * FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE token_id IN (:tokenIds)`,
      { tokenIds: [517, 518] }
    );
  });

  it('returns baked final subscribed count for an explicit dropped meme ID', async () => {
    jest.spyOn(nftsDb, 'getMaxMemeId').mockResolvedValue(516);
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockResolvedValue([{ count: '13' }]);

    await expect(fetchUpcomingMemeSubscriptionCounts(1, 516)).resolves.toEqual([
      { contract: MEMES_CONTRACT, token_id: 516, count: 13 }
    ]);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.stringContaining(`FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`),
      { contract: MEMES_CONTRACT, tokenId: 516 }
    );
  });
});

describe('fetchRedeemedMemeSubscriptionCountsDownload', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aggregates unique profiles and subscription counts for cards from id 220 onward', async () => {
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockResolvedValue([{ meme_id: 220 }]);

    await fetchRedeemedMemeSubscriptionCountsDownload();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `COALESCE(COUNT(DISTINCT ${SUBSCRIPTIONS_REDEEMED_TABLE}.consolidation_key), 0) AS unique_profiles`
      ),
      expect.objectContaining({
        startId: 220,
        contract: MEMES_CONTRACT
      })
    );

    const sql = executeSpy.mock.calls[0][0] as string;
    expect(sql).toContain(
      `COALESCE(SUM(${SUBSCRIPTIONS_REDEEMED_TABLE}.count), 0) AS subscriptions_count`
    );
    expect(sql).toContain(
      `COALESCE(SUM(${SUBSCRIPTIONS_REDEEMED_TABLE}.count), 0) * :mintPrice AS proceeds`
    );
    expect(sql).toContain(
      `DATE_FORMAT(${NFTS_TABLE}.mint_date, '%Y/%m/%d') AS drop_date`
    );
    expect(sql).toContain(`${NFTS_TABLE}.id >= :startId`);
    expect(sql).not.toContain(`${MEMES_EXTENDED_DATA_TABLE}.season = :szn`);
    expect(executeSpy.mock.calls[0][1]).toEqual({
      startId: 220,
      contract: MEMES_CONTRACT,
      mintPrice: MEMES_MINT_PRICE
    });
  });

  it('throws BadRequestException when query returns no results', async () => {
    jest.spyOn(sqlExecutor, 'execute').mockResolvedValue([]);

    await expect(fetchRedeemedMemeSubscriptionCountsDownload()).rejects.toThrow(
      'No data found for the selected filters'
    );
  });

  it('applies the szn filter when provided', async () => {
    const executeSpy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockResolvedValue([{ meme_id: 220 }]);

    await fetchRedeemedMemeSubscriptionCountsDownload(14);

    expect(executeSpy).toHaveBeenCalledTimes(1);

    const sql = executeSpy.mock.calls[0][0] as string;
    const params = executeSpy.mock.calls[0][1];

    expect(sql).toContain(`${MEMES_EXTENDED_DATA_TABLE}.season = :szn`);
    expect(params).toEqual({
      startId: 220,
      contract: MEMES_CONTRACT,
      mintPrice: MEMES_MINT_PRICE,
      szn: 14
    });
  });
});
