import { numbers } from '../../numbers';

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_SIZE = 2000;
/**
 * Upper bound for the `page` number of any paginated request. Keeps
 * `page_size * (page - 1)` far inside the safe integer range so the resulting
 * OFFSET is always an exactly representable, valid integer.
 */
export const MAX_PAGE = 1_000_000;
/**
 * Explicit page size for callers that intentionally fetch every row in a
 * single page (small, bounded reference tables and full exports). A page size
 * of zero or below never means "no limit".
 */
export const ALL_ROWS_PAGE_SIZE = Number.MAX_SAFE_INTEGER;

/**
 * Normalises an untrusted page size to an integer in `[1, max]`.
 * Values that are not integers (absent, NaN, non-numeric, fractional, arrays)
 * resolve to `fallback`, and values below 1 resolve to 1, so the result is
 * never zero or negative.
 */
export function normalizePageSize(
  value: unknown,
  max: number = ALL_ROWS_PAGE_SIZE,
  fallback: number = max
): number {
  const ceiling =
    Number.isSafeInteger(max) && max >= 1 ? max : DEFAULT_PAGE_SIZE;
  const parsed = numbers.parseIntOrNull(value) ?? fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
}

/**
 * Normalises an untrusted page number to an integer in `[1, MAX_PAGE]`.
 * Values that are not integers or are below 1 resolve to the first page.
 */
export function normalizePage(value: unknown): number {
  const parsed = numbers.parseIntOrNull(value);
  if (parsed === null || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, MAX_PAGE);
}

export interface PageRequest {
  page: number;
  page_size: number;
}

export interface Page<T> {
  count: number;
  page: number;
  next: boolean;
  data: T[];
}

export type CountlessPage<T> = Omit<Page<T>, 'count'>;

export function emptyPage<T>(pageNo = 1): Page<T> {
  return {
    count: 0,
    page: pageNo,
    next: false,
    data: []
  };
}

export enum PageSortDirection {
  ASC = 'ASC',
  DESC = 'DESC'
}

export interface FullPageRequest<SORT_BY_OPTIONS> {
  readonly sort_direction: PageSortDirection;
  readonly sort: SORT_BY_OPTIONS;
  readonly page: number;
  readonly page_size: number;
}
