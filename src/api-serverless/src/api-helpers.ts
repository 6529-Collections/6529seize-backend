import { Request, Response } from 'express';
import * as mcache from 'memory-cache';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  corsOptions,
  PaginatedResponse,
  CACHE_TIME_MS
} from './api-constants';

export function cacheKey(req: any) {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__` + req.originalUrl || req.url;
}

function fullUrl(req: any, next: string | null | boolean) {
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
    return (url += `&page=2`);
  }
}
export function returnJsonResult(response: Response, result: any) {
  response.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  response.setHeader(
    ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
    corsOptions.allowedHeaders
  );
  response.json(result);
}

export function returnPaginatedResult<T>(
  result: PaginatedResponse<T>,
  req: Request<any, any, any, any>,
  res: Response,
  skipCache?: boolean
) {
  result.next = fullUrl(req, result.next);

  if (!skipCache && result.count > 0) {
    mcache.put(cacheKey(req), result, CACHE_TIME_MS);
  }

  returnJsonResult(res, result);
}
