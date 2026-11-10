import { createHash } from 'node:crypto';
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
import { normalizeWebAppOrigin } from './web-app-origins';

const { json2csv } = require('json-2-csv');

function getCacheKeyPrefix(): string {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__`;
}

/**
 * Longest request URL (path plus normalised query) kept verbatim in a cache
 * key. A longer URL keeps its path, so path based evictions still match it,
 * and replaces the query with a SHA-256 of the whole normalised URL.
 */
export const MAX_VERBATIM_CACHE_KEY_URL_LENGTH = 512;
const HASHED_QUERY_PARAM = '__q';
const HASHED_PATH = '/__hashed-path';

function compareByName(a: [string, string], b: [string, string]): number {
  if (a[0] < b[0]) {
    return -1;
  }
  return a[0] > b[0] ? 1 : 0;
}

/**
 * The request URL in canonical form: the raw path followed by the query
 * parameters sorted by name. Values sharing a name keep their relative
 * order, so `?a=1&a=2` and `?a=2&a=1` stay distinct.
 */
export function normalizeRequestUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) {
    return url;
  }
  const path = url.slice(0, queryStart);
  const entries = Array.from(
    new URLSearchParams(url.slice(queryStart + 1)).entries()
  ).sort(compareByName);
  const query = new URLSearchParams(entries).toString();
  return query ? `${path}?${query}` : path;
}

export function cacheKey(req: Request) {
  const normalized = normalizeRequestUrl(req.originalUrl || req.url || '');
  if (normalized.length <= MAX_VERBATIM_CACHE_KEY_URL_LENGTH) {
    return getCacheKeyPrefix() + normalized;
  }
  const queryStart = normalized.indexOf('?');
  const path = queryStart < 0 ? normalized : normalized.slice(0, queryStart);
  const keyPath =
    path.length <= MAX_VERBATIM_CACHE_KEY_URL_LENGTH ? path : HASHED_PATH;
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `${getCacheKeyPrefix()}${keyPath}?${HASHED_QUERY_PARAM}=${digest}`;
}

const KNOWN_API_HOSTS = new Set(['api.6529.io', 'api.staging.6529.io']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    return host.slice(0, host.indexOf(']') + 1);
  }
  return host.split(':')[0];
}

/**
 * The origin for absolute pagination links. A configured `API_PUBLIC_ORIGIN`
 * wins; otherwise the request host is used only when it is a known API host
 * or a loopback address. Any other host yields root-relative links.
 */
function paginationOrigin(req: Request): string {
  const configured = normalizeWebAppOrigin(process.env.API_PUBLIC_ORIGIN);
  if (configured) {
    return configured;
  }
  const host = req.get('host')?.trim().toLowerCase();
  if (!host) {
    return '';
  }
  if (KNOWN_API_HOSTS.has(host) || LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
    return normalizeWebAppOrigin(`${req.protocol}://${host}`) ?? '';
  }
  return '';
}

function parseRequestPath(originalUrl: string): URL | null {
  const rooted = originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`;
  try {
    return new URL(`http://placeholder.invalid${rooted}`);
  } catch {
    return null;
  }
}

function fullUrl(req: Request, next: string | null) {
  const hasNext = next === 'true';

  if (!hasNext) {
    return null;
  }

  const parsed = parseRequestPath(req.originalUrl ?? '');
  if (!parsed) {
    return null;
  }
  const params = parsed.searchParams;
  // Collapse leading slashes so a relative link can never become
  // protocol-relative.
  const path = parsed.pathname.replace(/^\/+/, '/');

  if (params.has('page')) {
    const page = normalizePage(params.get('page'));
    if (page >= MAX_PAGE) {
      return null;
    }
    params.delete('page');
    params.append('page', String(page + 1));
    return `${paginationOrigin(req)}${path}${parsed.search}`;
  } else {
    let url = `${paginationOrigin(req)}${path}${parsed.search}`;
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
