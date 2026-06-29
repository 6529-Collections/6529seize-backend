import { ApiWaveVisibilityTier } from '@/api/generated/models/ApiWaveVisibilityTier';
import { DbPoolName } from '@/db-query.options';
import { sqs } from '@/sqs';
import { Time } from '@/time';
import { mapWaveScore } from './wave-score.api-mapper';
import {
  WAVE_SCORE_DIRTY_REFRESH_MESSAGE_GROUP_ID,
  WAVE_SCORE_DIRTY_REFRESH_QUEUE_NAME,
  WaveScoreDirtyRefreshReason,
  WaveScoreService
} from './wave-score.service';

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    wave_id: 'wave-1',
    creator_level_raw: null,
    drops_count: 0,
    latest_drop_timestamp: 0,
    wave_rep_total: 0,
    wave_rep_positive: 0,
    wave_rep_negative: 0,
    wave_rep_contributor_count: 0,
    wave_rep_positive_contributor_count: 0,
    wave_rep_negative_contributor_count: 0,
    total_posts: 0,
    level_weighted_posts: 0,
    trusted_author_count: 0,
    low_trust_drop_count: 0,
    top_author_drops: 0,
    latest_trusted_drop_timestamp: 0,
    recent_level_weighted_posts: 0,
    trusted_subscriber_count: 0,
    trusted_subscription_weight: 0,
    cross_mentions: 0,
    ...overrides
  };
}

function calculate(overrides: Record<string, unknown> = {}) {
  const service = new WaveScoreService(() => ({}) as any);
  return (service as any).calculate(makeInput(overrides));
}

describe('WaveScoreService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calculates a bounded no-signal score from neutral REP only', () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);

    const result = calculate();

    expect(result).toMatchObject({
      wave_id: 'wave-1',
      wave_score_version: 'wave-score-v1',
      wave_visibility_tier: ApiWaveVisibilityTier.Demoted,
      wave_visibility_rank: 3,
      wave_quality_score: 17.5,
      wave_hotness_score: 6.13,
      wave_rep_sort_score: 50,
      wave_visibility_score: 12.88,
      wave_creator_score: 0,
      wave_level_weighted_participation_score: 0,
      wave_trusted_diversity_score: 0,
      wave_rep_component_score: 50,
      wave_trusted_subscription_score: 0,
      wave_recent_trusted_activity_score: 0,
      wave_single_actor_penalty: 0,
      wave_low_trust_flood_penalty: 0,
      wave_cross_post_pressure: 0,
      wave_cross_post_penalty: 0,
      wave_negative_rep_penalty: 0,
      wave_safety_multiplier: 1,
      wave_score_calculated_at: 1_000
    });
  });

  it('weights signed REP as 35 percent of quality on a hundreds-of-millions scale', () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);

    const largePositiveRep = calculate({
      wave_rep_total: 25_000_000,
      wave_rep_positive: 25_000_000
    });
    const strongPositiveRep = calculate({
      wave_rep_total: 200_000_000,
      wave_rep_positive: 200_000_000
    });
    const strongNegativeRep = calculate({
      wave_rep_total: -200_000_000,
      wave_rep_negative: -200_000_000
    });

    expect(largePositiveRep.wave_rep_sort_score).toBe(94.56);
    expect(strongPositiveRep).toMatchObject({
      wave_rep_sort_score: 100,
      wave_rep_component_score: 100,
      wave_quality_score: 35,
      wave_visibility_score: 27.04
    });
    expect(strongNegativeRep).toMatchObject({
      wave_rep_sort_score: 0,
      wave_rep_component_score: 0,
      wave_quality_score: 0,
      wave_visibility_score: 0,
      wave_visibility_tier: ApiWaveVisibilityTier.Suppressed
    });
    expect(strongNegativeRep.wave_negative_rep_penalty).toBeCloseTo(35, 2);
  });

  it('rewards trusted poster levels, diversity, subscribers and recent activity', () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(10_000);

    const result = calculate({
      creator_level_raw: 1_000_000,
      total_posts: 100,
      level_weighted_posts: 1_200,
      trusted_author_count: 12,
      top_author_drops: 20,
      latest_trusted_drop_timestamp: 10_000,
      recent_level_weighted_posts: 600,
      trusted_subscriber_count: 40,
      trusted_subscription_weight: 2_000,
      wave_rep_total: 1_500,
      wave_rep_positive: 1_500,
      wave_rep_contributor_count: 12,
      wave_rep_positive_contributor_count: 12
    });

    expect(result.wave_visibility_tier).toBe(
      ApiWaveVisibilityTier.TrustedVisible
    );
    expect(result.wave_creator_score).toBeGreaterThan(80);
    expect(result.wave_level_weighted_participation_score).toBeGreaterThan(80);
    expect(result.wave_trusted_diversity_score).toBeGreaterThan(70);
    expect(result.wave_trusted_subscription_score).toBeGreaterThan(70);
    expect(result.wave_recent_trusted_activity_score).toBeGreaterThan(80);
    expect(result.wave_quality_score).toBeGreaterThan(75);
    expect(result.wave_hotness_score).toBeGreaterThan(80);
    expect(result.wave_visibility_score).toBeGreaterThan(80);
  });

  it('gates hotness contribution when quality is below the threshold', () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(10_000);

    const result = calculate({
      latest_trusted_drop_timestamp: 10_000,
      recent_level_weighted_posts: 600,
      wave_rep_total: -200_000_000,
      wave_rep_negative: -200_000_000
    });

    expect(result.wave_recent_trusted_activity_score).toBeGreaterThan(80);
    expect(result.wave_quality_score).toBe(0);
    expect(result.wave_hotness_score).toBeGreaterThan(35);
    expect(result.wave_visibility_score).toBe(0);
    expect(result.wave_visibility_tier).toBe(ApiWaveVisibilityTier.Suppressed);
  });

  it('maps gated hotness from the persisted score calculation', () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(10_000);

    const result = calculate({
      latest_trusted_drop_timestamp: 10_000,
      recent_level_weighted_posts: 300
    });

    const mappedScore = mapWaveScore(result as any);

    expect(result.wave_quality_score).toBeGreaterThan(0);
    expect(result.wave_quality_score).toBeLessThan(25);
    expect(mappedScore.quality_gate).toMatchObject({
      threshold: 25,
      multiplier: Math.round((result.wave_quality_score / 25) * 100) / 100,
      gated_hotness_score:
        Math.round(
          result.wave_hotness_score * (result.wave_quality_score / 25) * 100
        ) / 100
    });
    expect(mappedScore.quality_gate.gated_hotness_score).toBeLessThan(
      result.wave_hotness_score
    );
  });

  it('records cross-post pressure and applies the safety penalty', () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);

    const result = calculate({
      total_posts: 20,
      top_author_drops: 1,
      cross_mentions: 20
    });

    expect(result.wave_cross_post_pressure).toBe(100);
    expect(result.wave_cross_post_penalty).toBe(20);
    expect(result.wave_safety_multiplier).toBe(0.8);
  });

  it('does not fail callers when a best-effort score refresh fails', async () => {
    const service = new WaveScoreService(() => ({}) as any);
    jest
      .spyOn(service, 'refreshWaveScoresForWaveIds')
      .mockRejectedValue(new Error('score refresh failed'));

    await expect(
      service.refreshWaveScoresForWaveIdsBestEffort(['wave-1'])
    ).resolves.toBeUndefined();
  });

  it('caps refresh-all batch size for the join-heavy scoring query', async () => {
    const service = new WaveScoreService(() => ({}) as any);
    const getWaveIdsPage = jest
      .spyOn(service as any, 'getWaveIdsPage')
      .mockResolvedValue(['wave-1']);
    jest
      .spyOn(service, 'refreshWaveScoresForWaveIds')
      .mockResolvedValue(undefined);

    await service.refreshAllWaveScores({ batchSize: 1000, maxBatches: 1 });

    expect(getWaveIdsPage).toHaveBeenCalledWith(null, 100, {});
  });

  it('chunks oversized explicit refresh requests for the join-heavy scoring query', async () => {
    const service = new WaveScoreService(() => ({}) as any);
    const ensureWaveMetricRows = jest
      .spyOn(service as any, 'ensureWaveMetricRows')
      .mockResolvedValue(undefined);
    const getScoreInputRows = jest
      .spyOn(service as any, 'getScoreInputRows')
      .mockResolvedValue([]);
    const waveIds = Array.from({ length: 205 }, (_, index) => `wave-${index}`);

    await service.refreshWaveScoresForWaveIds(waveIds);

    expect(ensureWaveMetricRows).toHaveBeenCalledTimes(3);
    expect(getScoreInputRows).toHaveBeenCalledTimes(3);
    expect(
      ensureWaveMetricRows.mock.calls.map(([ids]) => (ids as string[]).length)
    ).toEqual([100, 100, 5]);
    expect(
      getScoreInputRows.mock.calls.map(([ids]) => (ids as string[]).length)
    ).toEqual([100, 100, 5]);
  });

  it('marks distinct waves dirty with a monotonic dirty timestamp inside the caller connection', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(12_345);
    const execute = jest.fn().mockResolvedValue([]);
    const service = new WaveScoreService(() => ({ execute }) as any);
    const connection = {} as any;

    await service.markWaveScoresDirty(
      ['wave-1', 'wave-1', ''],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      { connection }
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('insert into wave_score_refresh_requests'),
      expect.objectContaining({
        waveId0: 'wave-1',
        reason0: WaveScoreDirtyRefreshReason.DROP_CHANGED,
        dirtyAt0: 12_345,
        createdAt0: 12_345,
        updatedAt0: 12_345
      }),
      { wrappedConnection: connection }
    );
    expect(execute.mock.calls[0]?.[0]).toContain('greatest(');
  });

  it('drains dirty wave refresh rows from the write pool and deletes only the captured dirty timestamp', async () => {
    const execute = jest.fn(async (sql: string) => {
      if (sql.includes('select wave_id, dirty_at')) {
        return [{ wave_id: 'wave-1', dirty_at: '1000' }];
      }
      return [];
    });
    const service = new WaveScoreService(() => ({ execute }) as any);
    jest
      .spyOn(service, 'refreshWaveScoresForWaveIds')
      .mockResolvedValue(undefined);

    await expect(
      service.refreshDirtyWaveScores({ batchSize: 10, maxBatches: 1 })
    ).resolves.toEqual({
      batches: 1,
      waves: 1,
      hasMore: false
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('select wave_id, dirty_at'),
      { batchSize: 10 },
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
    expect(service.refreshWaveScoresForWaveIds).toHaveBeenCalledWith(
      ['wave-1'],
      {}
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'where (wave_id, dirty_at) in ((:dirtyWaveId0, :dirtyAt0))'
      ),
      {
        dirtyWaveId0: 'wave-1',
        dirtyAt0: 1000
      },
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });

  it('persists and enqueues async dirty refresh requests', async () => {
    const service = new WaveScoreService(() => ({}) as any);
    const markWaveScoresDirty = jest
      .spyOn(service, 'markWaveScoresDirty')
      .mockResolvedValue(undefined);
    const enqueueDirtyWaveScoreRefresh = jest
      .spyOn(service, 'enqueueDirtyWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);

    await service.requestWaveScoreRefreshBestEffort(
      ['wave-1'],
      WaveScoreDirtyRefreshReason.WAVE_REP_CHANGED
    );

    expect(markWaveScoresDirty).toHaveBeenCalledWith(
      ['wave-1'],
      WaveScoreDirtyRefreshReason.WAVE_REP_CHANGED,
      {}
    );
    expect(enqueueDirtyWaveScoreRefresh).toHaveBeenCalledWith({});
  });

  it('sends unique dirty refresh wakeups to the dirty FIFO queue', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(12_345);
    const sendToQueueName = jest
      .spyOn(sqs, 'sendToQueueName')
      .mockResolvedValue(undefined);
    const service = new WaveScoreService(() => ({}) as any);

    await service.enqueueDirtyWaveScoreRefresh();

    expect(sendToQueueName).toHaveBeenCalledWith({
      queueName: WAVE_SCORE_DIRTY_REFRESH_QUEUE_NAME,
      messageGroupId: WAVE_SCORE_DIRTY_REFRESH_MESSAGE_GROUP_ID,
      message: {
        mode: 'DIRTY',
        requestedAt: 12_345,
        nonce: expect.any(String)
      }
    });
  });
});
