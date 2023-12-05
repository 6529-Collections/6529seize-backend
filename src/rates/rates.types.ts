import { RateCategoryMedia } from '../entities/IRateMatter';

export interface RateCategoryInfo {
  category_tag: string;
  tally: number;
  category_display_name: string;
  category_media: RateCategoryMedia;
  category_enabled: boolean;
  authenticated_profile_rates: number;
}

export interface AggregatedCicRating {
  cic_rating: number;
  contributor_count: number;
}
