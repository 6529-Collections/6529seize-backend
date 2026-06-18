import { BadRequestException } from '@/exceptions';

export const METRICS_SORT = [
  'level',
  'balance',
  'unique_memes',
  'memes_cards_sets',
  'tdh',
  'boosted_tdh',
  'day_change'
] as const;

export type MetricsSort = (typeof METRICS_SORT)[number];

export function resolveMetricsSort(sort: unknown): MetricsSort {
  if (!sort) {
    return METRICS_SORT[0];
  }

  if (typeof sort !== 'string') {
    throw new BadRequestException('sort must be a string');
  }

  const normalizedSort = sort.toLowerCase();
  if (!METRICS_SORT.includes(normalizedSort as MetricsSort)) {
    throw new BadRequestException(`Unsupported sort field: ${sort}`);
  }

  return normalizedSort as MetricsSort;
}
