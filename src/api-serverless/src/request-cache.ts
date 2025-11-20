import { NextFunction, Request, RequestHandler, Response } from 'express';
import { OutgoingHttpHeaders } from 'http';
import { Time } from '../../time';
import { Logger } from '../../logging';
import { redisGet, redisSetJson } from '../../redis';
import { CACHE_TIME_MS } from './api-constants';
import { cacheKey } from './api-helpers';

const logger = Logger.get('REQUEST_CACHE');

const REQUEST_CACHE_MARKER = '__requestCache';

export interface CachedResponsePayload {
  [REQUEST_CACHE_MARKER]: true;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
}

export interface RequestCacheOptions {
  ttl?: Time;
  key?: (req: Request) => string | null;
  methods?: string[];
  shouldCacheResponse?: (req: Request, res: Response) => boolean;
  authDependent?: boolean;
}

const DEFAULT_TTL = Time.millis(CACHE_TIME_MS);
const AUTH_CACHE_KEY_SEPARATOR = '__AUTH__';
const ANONYMOUS_CACHE_KEY = 'anonymous';

type CacheRequestHandler = RequestHandler<any, any, any, any, any>;

export function cacheRequest(
  options?: RequestCacheOptions
): CacheRequestHandler {
  const ttl = options?.ttl ?? DEFAULT_TTL;
  const allowedMethods = options?.methods?.map((method) =>
    method.toUpperCase()
  ) ?? ['GET'];
  return async (
    req: Request<any, any, any, any, any>,
    res: Response<any, any>,
    next: NextFunction
  ) => {
    if (!allowedMethods.includes(req.method.toUpperCase())) {
      return next();
    }

    const baseKey = options?.key?.(req) ?? cacheKey(req);
    if (!baseKey) {
      return next();
    }
    const key = options?.authDependent
      ? withAuthCacheDependency(baseKey, req)
      : baseKey;

    try {
      const cached = await redisGet<CachedResponsePayload>(key);
      if (isRequestCacheEntry(cached)) {
        applyCachedHeaders(res, cached.headers);
        res.status(cached.statusCode);
        const body = Buffer.from(cached.body, 'base64');
        res.send(body);
        return;
      }
      if (cached) {
        logger.warn('Ignoring cache entry with unexpected shape', {
          path: req.originalUrl
        });
      }
    } catch (error) {
      logger.warn('Failed to read request cache entry', error);
    }

    const chunks: Buffer[] = [];
    const originalWrite = res.write;
    const originalEnd = res.end;

    const captureChunk = (chunk?: any, encodingArg?: any) => {
      if (chunk === undefined || chunk === null) {
        return;
      }
      const encoding =
        typeof encodingArg === 'string'
          ? (encodingArg as BufferEncoding)
          : undefined;
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
        return;
      }
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, encoding));
      }
    };

    (res as any).write = function patchedWrite(
      ...writeArgs: Parameters<typeof res.write>
    ) {
      const [chunk, encoding] = writeArgs;
      captureChunk(chunk, encoding);
      return originalWrite.apply(res, writeArgs as any);
    };

    (res as any).end = function patchedEnd(
      ...endArgs: Parameters<typeof res.end>
    ) {
      const [chunk, encoding] = endArgs;
      captureChunk(chunk, encoding);
      return originalEnd.apply(res, endArgs as any);
    };

    const restoreOriginalStreamMethods = () => {
      (res as any).write = originalWrite;
      (res as any).end = originalEnd;
    };

    res.on('finish', async () => {
      restoreOriginalStreamMethods();
      const shouldCache =
        options?.shouldCacheResponse?.(req, res) ??
        isDefaultCacheableStatus(res.statusCode);
      if (!shouldCache) {
        return;
      }
      try {
        const bufferedBody = Buffer.concat(chunks);
        const headers = sanitizeHeaders(res.getHeaders());
        const payload: CachedResponsePayload = {
          [REQUEST_CACHE_MARKER]: true,
          statusCode: res.statusCode,
          headers,
          body: bufferedBody.toString('base64')
        };
        await redisSetJson(key, payload, ttl);
      } catch (error) {
        logger.warn('Failed to store request cache entry', error);
      }
    });

    res.on('close', restoreOriginalStreamMethods);

    next();
  };
}

export function isRequestCacheEntry(
  value: unknown
): value is CachedResponsePayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate[REQUEST_CACHE_MARKER] !== true) {
    return false;
  }
  return (
    typeof candidate.statusCode === 'number' &&
    typeof candidate.body === 'string' &&
    candidate.headers !== null &&
    typeof candidate.headers === 'object'
  );
}

function applyCachedHeaders(
  res: Response,
  headers: Record<string, string | number | string[]>
) {
  Object.entries(headers).forEach(([header, value]) => {
    if (header.toLowerCase() === 'content-length') {
      return;
    }
    res.setHeader(header, value as any);
  });
}

function sanitizeHeaders(
  headers: OutgoingHttpHeaders
): Record<string, string | number | string[]> {
  return Object.entries(headers).reduce<
    Record<string, string | number | string[]>
  >((accumulator, [header, value]) => {
    if (value === undefined) {
      return accumulator;
    }
    const headerName = header.toLowerCase();
    if (headerName === 'content-length' || headerName === 'content-encoding') {
      return accumulator;
    }
    accumulator[header] = value as string | number | string[];
    return accumulator;
  }, {});
}

function withAuthCacheDependency(baseKey: string, req: Request): string {
  const rawHeader = req.headers?.authorization;
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const normalizedAuth = header?.trim() || ANONYMOUS_CACHE_KEY;
  return `${baseKey}${AUTH_CACHE_KEY_SEPARATOR}${normalizedAuth}`;
}

function isDefaultCacheableStatus(statusCode: number) {
  return (statusCode >= 200 && statusCode < 300) || statusCode === 304;
}
