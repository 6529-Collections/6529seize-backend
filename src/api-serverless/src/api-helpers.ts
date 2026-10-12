import { Request, Response } from 'express';
import { numbers } from '../../numbers';
import { Time } from '../../time';
import {
  CONTENT_TYPE_HEADER,
  DEFAULT_PAGE_SIZE,
  PaginatedResponse,
  SORT_DIRECTIONS
} from './api-constants';
import { MAX_PAGE, normalizePage, normalizePageSize } from './page-request';

const { json2csv } = require('json-2-csv');

function getCacheKeyPrefix(): string {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__`;
}

export function cacheKey(req: Request) {
  return getCacheKeyPrefix() + (req.originalUrl || req.url);
}

function fullUrl(req: Request, next: string | null) {
  let url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  const hasNext = next === 'true';

  if (!hasNext) {
    return null;
  }

  const newUrl = new URL(url);
  const params = newUrl.searchParams;

  if (params.has('page')) {
    const page = normalizePage(params.get('page'));
    if (page >= MAX_PAGE) {
      return null;
    }
    newUrl.searchParams.delete('page');
    newUrl.searchParams.append('page', String(page + 1));
    return newUrl.toString();
  } else {
    if (!url.includes('?')) {
      url += '?';
    }
    url += `&page=2`;
    return url;
  }
}

export async function returnCSVResult(
  fileName: string,
  results: any,
  response: Response
) {
  const csv = json2csv(results);
  response.header(CONTENT_TYPE_HEADER, 'text/csv');
  response.attachment(`${fileName}.csv`);
  return response.send(csv);
}

export function transformPaginatedResponse<K, V>(
  transformer: (original: K) => V,
  original: PaginatedResponse<K>
): PaginatedResponse<V> {
  return {
    count: original.count,
    page: original.page,
    next: original.next,
    data: original.data.map(transformer)
  };
}

export function returnPaginatedResult<T>(
  result: PaginatedResponse<T>,
  request: Request<any, any, any, any>,
  response: Response
): Response {
  result.next = fullUrl(request, result.next);
  return response.json(result);
}

export function constructFilters(f: string, newF: string) {
  if (f.trim().toUpperCase().startsWith('WHERE')) {
    return ` ${f} AND ${newF} `;
  }
  return ` WHERE ${newF} `;
}

export function constructFiltersOR(f: string, newF: string) {
  if (f.trim() != '') {
    return ` ${f} OR ${newF} `;
  }
  return ` ${newF} `;
}

export function resolveIntParam(param: string | string[] | undefined) {
  if (param) {
    return numbers.parseIntOrNull(param as string) ?? undefined;
  }
  return undefined;
}

export function giveReadReplicaTimeToCatchUp(millisToGive?: number | null) {
  const ms =
    millisToGive ??
    numbers.parseIntOrNull(process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE) ??
    500;
  return Time.millis(ms).sleep();
}

export function resolveSortDirection(direction: any) {
  return direction && SORT_DIRECTIONS.includes(direction.toUpperCase())
    ? direction
    : 'DESC';
}

export function getSearchFilters(columnNames: string[], search: string) {
  let filters = '';
  const params: any = {};
  search
    .toLowerCase()
    .split(',')
    .forEach((s: string, index: number) => {
      params[`search${index}`] = `%${s}%`;
      filters = constructFiltersOR(
        filters,
        columnNames.map((c) => `${c} like :search${index}`).join(' OR ')
      );
    });
  return { filters, params };
}

/**
 * Resolves the requested page size to an integer in [1, max]. An absent or
 * invalid value resolves to `max`, and values below 1 resolve to 1.
 */
export function getPageSize(req: any, maxSize?: number): number {
  return normalizePageSize(req.query.page_size, maxSize ?? DEFAULT_PAGE_SIZE);
}

/**
 * Resolves the requested page to an integer in [1, MAX_PAGE]. An absent,
 * invalid or non-positive value resolves to the first page.
 */
export function getPage(req: any): number {
  return normalizePage(req.query.page);
}
