import { Request, Response } from 'express';
import { numbers } from '../../numbers';
import { Time } from '../../time';
import {
  CONTENT_TYPE_HEADER,
  DEFAULT_PAGE_SIZE,
  PaginatedResponse,
  SORT_DIRECTIONS
} from './api-constants';

const converter = require('json-2-csv');

function getCacheKeyPrefix(): string {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__`;
}

export function cacheKey(req: Request) {
  return getCacheKeyPrefix() + (req.originalUrl || req.url);
}

export function getCacheKeyPatternForPath(path: string): string {
  return `${getCacheKeyPrefix()}${path}`;
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
    const page = numbers.parseIntOrNull(params.get('page')!) ?? 1;
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
  const csv = await converter.json2csvAsync(results);
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

export function getPageSize(req: any, maxSize?: number): number {
  const max = maxSize ?? DEFAULT_PAGE_SIZE;
  const parsed = numbers.parseIntOrNull(req.query.page_size);
  return parsed !== null && parsed < max ? parsed : max;
}

export function getPage(req: any): number {
  return numbers.parseIntOrNull(req.query.page) ?? 1;
}
