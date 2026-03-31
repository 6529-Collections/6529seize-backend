import { Seed } from '../_setup/seed';
import { RATINGS_TABLE } from '@/constants';
import { RateMatter, Rating } from '@/entities/IRating';
import { Time } from '@/time';

export function aRepRating(
  params: Omit<Rating, 'matter' | 'last_modified'>
): Rating {
  return {
    ...params,
    matter: RateMatter.REP,
    last_modified: Time.epoch().toDate()
  };
}

export function aCicRating(
  params: Omit<Rating, 'matter' | 'last_modified' | 'matter_category'>
): Rating {
  return {
    ...params,
    matter: RateMatter.CIC,
    last_modified: Time.epoch().toDate(),
    matter_category: RateMatter.CIC
  };
}

export function withRatings(entities: Rating[]): Seed {
  return {
    table: RATINGS_TABLE,
    rows: entities
  };
}
