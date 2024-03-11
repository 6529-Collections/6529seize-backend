export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_SIZE = 2000;

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
