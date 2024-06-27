import { Request, Response } from 'express';
import * as mcache from 'memory-cache';
import {
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  CACHE_TIME_MS,
  CONTENT_TYPE_HEADER,
  corsOptions,
  DEFAULT_PAGE_SIZE,
  JSON_HEADER_VALUE,
  PaginatedResponse,
  SORT_DIRECTIONS
} from './api-constants';
import { Time } from '../../time';
import { parseNumberOrNull } from '../../helpers';

const converter = require('json-2-csv');

export function cacheKey(req: Request) {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__` + req.originalUrl || req.url;
}

function fullUrl(req: Request, next: string | null | boolean) {
  let url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  if (!next) {
    return null;
  }

  const newUrl = new URL(url);
  const params = newUrl.searchParams;

  if (params.has('page')) {
    const page = parseInt(params.get('page')!);
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

export function returnJsonResult(
  result: any,
  request: Request,
  response: Response,
  skipCache?: boolean
) {
  if (!skipCache && result.count > 0) {
    mcache.put(cacheKey(request), result, CACHE_TIME_MS);
  }

  response.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  response.setHeader(
    ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
    corsOptions.allowedHeaders
  );
  response.json(result);
}

export function returnPaginatedResult<T>(
  result: PaginatedResponse<T>,
  request: Request<any, any, any, any>,
  response: Response,
  skipCache?: boolean
) {
  result.next = fullUrl(request, result.next);
  returnJsonResult(result, request, response, skipCache);
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
    const parsed = parseInt(param as string);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function giveReadReplicaTimeToCatchUp(millisToGive?: number) {
  const ms =
    millisToGive ??
    parseNumberOrNull(process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE) ??
    500;
  return Time.millis(ms).sleep();
}

export function resolveSortDirection(direction: any) {
  return direction && SORT_DIRECTIONS.includes(direction.toUpperCase())
    ? direction
    : 'asc';
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

export function getPageSize(req: any): number {
  return req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
    ? parseInt(req.query.page_size)
    : DEFAULT_PAGE_SIZE;
}

export function getPage(req: any): number {
  return req.query.page ? parseInt(req.query.page) : 1;
}
