import { WaveMetricEntity } from '@/entities/IWaveMetric';
import { enums } from '@/enums';
import { ApiWaveRepCategorySummary } from '@/api/generated/models/ApiWaveRepCategorySummary';
import { ApiWaveRepSummary } from '@/api/generated/models/ApiWaveRepSummary';
import { ApiWaveScore } from '@/api/generated/models/ApiWaveScore';
import { ApiWaveVisibilityTier } from '@/api/generated/models/ApiWaveVisibilityTier';
import {
  LOW_TRUST_LEVEL_RAW,
  MAX_LEVEL_RAW_FOR_SCORE,
  MAX_WAVE_REP_FOR_SCORE,
  MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY,
  RECENT_ACTIVITY_WINDOW_MS,
  TRUSTED_LEVEL_RAW,
  WAVE_SCORE_HOTNESS_COMPONENT_WEIGHTS,
  WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS,
  WAVE_SCORE_VERSION,
  WAVE_SCORE_VISIBILITY_COMPONENT_WEIGHTS
} from './wave-score.constants';

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
  const qualityScore = toNumber(metrics?.wave_quality_score);
  const hotnessScore = toNumber(metrics?.wave_hotness_score);
  const hotnessVisibilityMultiplier = clamp(
    qualityScore / MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY,
    0,
    1
  );

  return {
    score_version: metrics?.wave_score_version ?? WAVE_SCORE_VERSION,
    visibility_tier:
      enums.resolve(ApiWaveVisibilityTier, metrics?.wave_visibility_tier) ??
      ApiWaveVisibilityTier.ExplorationNeutral,
    quality_score: qualityScore,
    hotness_score: hotnessScore,
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
    quality_gate: {
      threshold: MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY,
      multiplier: roundScore(hotnessVisibilityMultiplier),
      gated_hotness_score: roundScore(
        hotnessScore * hotnessVisibilityMultiplier
      )
    },
    formula: {
      max_level_raw_for_score: MAX_LEVEL_RAW_FOR_SCORE,
      max_wave_rep_for_score: MAX_WAVE_REP_FOR_SCORE,
      trusted_level_raw: TRUSTED_LEVEL_RAW,
      low_trust_level_raw: LOW_TRUST_LEVEL_RAW,
      recent_activity_window_ms: RECENT_ACTIVITY_WINDOW_MS,
      quality_component_weights: WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS,
      hotness_component_weights: WAVE_SCORE_HOTNESS_COMPONENT_WEIGHTS,
      visibility_component_weights: WAVE_SCORE_VISIBILITY_COMPONENT_WEIGHTS
    },
    calculated_at: toNumber(metrics?.wave_score_calculated_at)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
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
