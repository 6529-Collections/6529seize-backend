import { MEMES_CONTRACT } from '@/constants';
import { getMaxMemeId } from '../../../nftsLoop/db.nfts';
import { sqlExecutor } from '../../../sql-executor';
import { fetchSubscriptionEligibility } from '../../../subscriptionsDaily/db.subscriptions';
import { fetchUpcomingMemeSubscriptionStatusForConsolidationKey } from './api.subscriptions.db';

jest.mock('../../../nftsLoop/db.nfts', () => ({
  getMaxMemeId: jest.fn()
}));

jest.mock('../../../sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn()
  }
}));

jest.mock('../../../subscriptionsDaily/db.subscriptions', () => ({
  fetchSubscriptionEligibility: jest.fn()
}));

const mockedGetMaxMemeId = getMaxMemeId as jest.MockedFunction<
  typeof getMaxMemeId
>;
const mockedExecute = sqlExecutor.execute as jest.MockedFunction<
  typeof sqlExecutor.execute
>;
const mockedFetchSubscriptionEligibility =
  fetchSubscriptionEligibility as jest.MockedFunction<
    typeof fetchSubscriptionEligibility
  >;

describe('fetchUpcomingMemeSubscriptionStatusForConsolidationKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetMaxMemeId.mockResolvedValue(100);
    mockedFetchSubscriptionEligibility.mockResolvedValue(1);
  });

  it('throws 400 when meme is already dropped', async () => {
    mockedGetMaxMemeId.mockResolvedValue(12);

    await expect(
      fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
        'test-consolidation',
        12
      )
    ).rejects.toThrow('already dropped');

    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('returns dedicated subscription when explicitly subscribed', async () => {
    mockedFetchSubscriptionEligibility.mockResolvedValue(2);
    mockedExecute
      .mockResolvedValueOnce([]) // mode lookup
      .mockResolvedValueOnce([
        {
          consolidation_key: 'test-consolidation',
          contract: MEMES_CONTRACT,
          token_id: 420,
          subscribed: true,
          subscribed_count: 2
        } as any
      ]);

    const result = await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
      'test-consolidation',
      420
    );

    expect(result).toEqual({
      subscribed: true,
      eligibility: 2,
      count: 2,
      source: 'manual'
    });
  });

  it('returns automatic subscription when no dedicated override exists', async () => {
    mockedFetchSubscriptionEligibility.mockResolvedValue(3);
    mockedExecute
      .mockResolvedValueOnce([
        {
          consolidation_key: 'test-consolidation',
          automatic: true,
          subscribe_all_editions: true,
          created_at: new Date('2026-02-09T00:00:00.000Z'),
          updated_at: new Date('2026-02-11T00:00:00.000Z')
        } as any
      ]) // mode lookup
      .mockResolvedValueOnce([]); // dedicated subscription lookup

    const result = await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
      'test-consolidation',
      421
    );

    expect(result).toEqual({
      subscribed: true,
      eligibility: 3,
      count: 3,
      source: 'automatic'
    });
    expect(mockedFetchSubscriptionEligibility).toHaveBeenCalledWith(
      'test-consolidation'
    );
  });

  it('returns unsubscribed payload when user explicitly unsubscribed from the meme', async () => {
    mockedExecute
      .mockResolvedValueOnce([]) // mode lookup
      .mockResolvedValueOnce([
        {
          consolidation_key: 'test-consolidation',
          contract: MEMES_CONTRACT,
          token_id: 422,
          subscribed: false,
          subscribed_count: 1
        } as any
      ]);

    const result = await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
      'test-consolidation',
      422
    );

    expect(result).toEqual({
      subscribed: false,
      eligibility: 1
    });
  });

  it('returns unsubscribed payload when there is no dedicated subscription and automatic mode is disabled', async () => {
    mockedExecute
      .mockResolvedValueOnce([]) // mode lookup
      .mockResolvedValueOnce([]); // dedicated subscription lookup

    const result = await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
      'test-consolidation',
      423
    );

    expect(result).toEqual({
      subscribed: false,
      eligibility: 1
    });
  });
});
