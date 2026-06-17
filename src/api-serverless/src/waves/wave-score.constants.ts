import { Time } from '@/time';

export const WAVE_SCORE_VERSION = 'wave-score-v1';
export const WAVE_SCORE_MAX_BACKFILL_BATCH_SIZE = 100;
export const WAVE_SCORE_DEFAULT_BACKFILL_BATCH_SIZE = 100;
export const MAX_LEVEL_RAW_FOR_SCORE = 25000000;
export const MAX_WAVE_REP_FOR_SCORE = 200000000;
export const MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY = 25;
export const TRUSTED_LEVEL_RAW = 1000;
export const LOW_TRUST_LEVEL_RAW = 25;
export const RECENT_ACTIVITY_WINDOW_MS = Time.days(7).toMillis();
export const RECENT_ACTIVITY_HALF_LIFE_MS = Time.days(2).toMillis();
export const PARTICIPATION_SATURATION_SCALE = 600;
export const TRUSTED_DIVERSITY_SATURATION_SCALE = 8;
export const TRUSTED_SUBSCRIPTION_SATURATION_SCALE = 30;
export const RECENT_ACTIVITY_SATURATION_SCALE = 250;
export const TRUSTED_VISIBLE_MIN_VISIBILITY_SCORE = 55;
export const EXPLORATION_NEUTRAL_MIN_VISIBILITY_SCORE = 25;
export const DEMOTED_MIN_VISIBILITY_SCORE = 10;

export const WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS = {
  creator_score: 0.2,
  level_weighted_participation_score: 0.2,
  trusted_diversity_score: 0.15,
  trusted_subscription_score: 0.1,
  wave_rep_component_score: 0.35
} as const;

export const WAVE_SCORE_HOTNESS_COMPONENT_WEIGHTS = {
  recent_trusted_activity_score: 0.65,
  quality_score: 0.35
} as const;

export const WAVE_SCORE_VISIBILITY_COMPONENT_WEIGHTS = {
  quality_score: 0.65,
  gated_hotness_score: 0.35
} as const;
