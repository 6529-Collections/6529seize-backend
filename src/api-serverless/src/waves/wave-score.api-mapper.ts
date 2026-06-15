import { WaveMetricEntity } from '@/entities/IWaveMetric';
import { enums } from '@/enums';
import { ApiWaveRepCategorySummary } from '@/api/generated/models/ApiWaveRepCategorySummary';
import { ApiWaveRepSummary } from '@/api/generated/models/ApiWaveRepSummary';
import { ApiWaveScore } from '@/api/generated/models/ApiWaveScore';
import { ApiWaveVisibilityTier } from '@/api/generated/models/ApiWaveVisibilityTier';

export function mapWaveRepSummary(
  metrics: WaveMetricEntity | undefined,
  categories: ApiWaveRepCategorySummary[] = [],
  authenticatedUserContribution: number | null = null
): ApiWaveRepSummary {
  return {
    total_rep: toNumber(metrics?.wave_rep_total),
    positive_rep: toNumber(metrics?.wave_rep_positive),
    negative_rep: toNumber(metrics?.wave_rep_negative),
    contributor_count: toNumber(metrics?.wave_rep_contributor_count),
    positive_contributor_count: toNumber(
      metrics?.wave_rep_positive_contributor_count
    ),
    negative_contributor_count: toNumber(
      metrics?.wave_rep_negative_contributor_count
    ),
    authenticated_user_contribution: authenticatedUserContribution,
    categories
  };
}

export function mapWaveScore(
  metrics: WaveMetricEntity | undefined
): ApiWaveScore {
  return {
    score_version: metrics?.wave_score_version ?? 'wave-score-v1',
    visibility_tier:
      enums.resolve(ApiWaveVisibilityTier, metrics?.wave_visibility_tier) ??
      ApiWaveVisibilityTier.ExplorationNeutral,
    quality_score: toNumber(metrics?.wave_quality_score),
    hotness_score: toNumber(metrics?.wave_hotness_score),
    rep_sort_score: toNumber(metrics?.wave_rep_sort_score, 50),
    visibility_score: toNumber(metrics?.wave_visibility_score),
    components: {
      creator_score: toNumber(metrics?.wave_creator_score),
      level_weighted_participation_score: toNumber(
        metrics?.wave_level_weighted_participation_score
      ),
      trusted_diversity_score: toNumber(metrics?.wave_trusted_diversity_score),
      wave_rep_component_score: toNumber(metrics?.wave_rep_component_score, 50),
      trusted_subscription_score: toNumber(
        metrics?.wave_trusted_subscription_score
      ),
      recent_trusted_activity_score: toNumber(
        metrics?.wave_recent_trusted_activity_score
      )
    },
    penalties: {
      single_actor_penalty: toNumber(metrics?.wave_single_actor_penalty),
      low_trust_flood_penalty: toNumber(metrics?.wave_low_trust_flood_penalty),
      cross_post_pressure: toNumber(metrics?.wave_cross_post_pressure),
      cross_post_penalty: toNumber(metrics?.wave_cross_post_penalty),
      negative_rep_penalty: toNumber(metrics?.wave_negative_rep_penalty),
      safety_multiplier: toNumber(metrics?.wave_safety_multiplier, 1)
    },
    calculated_at: toNumber(metrics?.wave_score_calculated_at)
  };
}

function toNumber(
  value: number | string | null | undefined,
  fallback = 0
): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  return Number(value) || fallback;
}
