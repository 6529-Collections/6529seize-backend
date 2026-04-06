import { Seed } from '../_setup/seed';
import { RATINGS_TABLE } from '@/constants';
import { RateMatter, Rating } from '@/entities/IRating';

const DEFAULT_RATING_LAST_MODIFIED = new Date('2024-01-01T00:00:00Z');

export function aRepRating(
  params: Omit<Rating, 'matter' | 'last_modified'>
): Rating {
  return {
    ...params,
    matter: RateMatter.REP,
    last_modified: DEFAULT_RATING_LAST_MODIFIED
  };
}

export function aCicRating(
  params: Omit<Rating, 'matter' | 'last_modified' | 'matter_category'>
): Rating {
  return {
    ...params,
    matter: RateMatter.CIC,
    last_modified: DEFAULT_RATING_LAST_MODIFIED,
    matter_category: RateMatter.CIC
  };
}

export function withRatings(entities: Rating[]): Seed {
  return {
    table: RATINGS_TABLE,
    rows: entities
  };
}
