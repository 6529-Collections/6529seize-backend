const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_SIZE = 2000;

export interface RawPageRequest {
  page?: string;
  page_size?: string;
}

export interface PageRequest {
  page: number;
  page_size: number;
}

export function getPageRequestOrDefault(
  pageRequest?: RawPageRequest,
  opts?: { defaultPageSize?: number; pageMaxSize?: number }
): PageRequest {
  const defaultPageSize = opts?.defaultPageSize || DEFAULT_PAGE_SIZE;
  const maxPageSize = opts?.pageMaxSize || DEFAULT_MAX_SIZE;
  const givenPage = pageRequest?.page;
  let page = 1;
  if (typeof givenPage === 'string') {
    const maybePageNumber = Number(givenPage);
    if (!isNaN(maybePageNumber) && maybePageNumber > 0) {
      page = maybePageNumber;
    }
  }
  let pageSize = defaultPageSize;
  const givenPageSize = pageRequest?.page_size;
  if (typeof givenPageSize === 'string') {
    const maybePageSize = Number(givenPageSize);
    if (!isNaN(maybePageSize)) {
      if (maybePageSize > maxPageSize) {
        pageSize = maxPageSize;
      } else if (maybePageSize > 0) {
        pageSize = maybePageSize;
      }
    }
  }
  return {
    page,
    page_size: pageSize
  };
}
