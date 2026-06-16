import { ApiWaveVisibilityTier } from '@/api/generated/models/ApiWaveVisibilityTier';
import { Time } from '@/time';
import { WaveScoreService } from './wave-score.service';

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
});
