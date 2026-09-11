import { ErrorRequestHandler, Request } from 'express';
import { z } from 'zod';
import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import {
  ApiCompliantException,
  BadRequestException,
  CustomApiCompliantException
} from '@/exceptions';
import { MarketValidationError } from '@/marketplace/provider.types';

type MarketRequest = Pick<
  Request<unknown, unknown, unknown, unknown>,
  'params' | 'body' | 'query' | 'get'
> & { res?: { set(headers: Record<string, string>): unknown } };

export function sanitizeMarketError(error: unknown): ApiCompliantException {
  if (error instanceof ApiCompliantException) {
    return new CustomApiCompliantException(
      error.getStatusCode(),
      error.message,
      error.code
    );
  }
  const parserError = error as { type?: unknown; status?: unknown } | null;
  if (parserError?.type === 'entity.parse.failed' && parserError.status === 400)
    return new CustomApiCompliantException(
      400,
      'Invalid trade JSON.',
      'INVALID_JSON'
    );
  if (parserError?.type === 'entity.too.large' && parserError.status === 413)
    return new CustomApiCompliantException(
      413,
      'Trade request is too large.',
      'REQUEST_TOO_LARGE'
    );
  return new CustomApiCompliantException(
    503,
    'The operation could not be verified. Refresh before trying again.',
    'MARKET_UNAVAILABLE'
  );
}

export const marketErrorMiddleware: ErrorRequestHandler = (
  error,
  req,
  res,
  next
) => {
  if (!/^\/api\/(market|collect)(?:\/|$)/.test(req.path)) return next(error);
  req.body = undefined;
  req.query = {};
  res.set('Cache-Control', 'private, no-store');
  // Auth and JSON parsing can fail before our handlers run. Parser exceptions
  // carry raw input, including order signatures, so replace them before telemetry.
  return next(sanitizeMarketError(error));
};

export async function executeMarketRequest<T>(
  req: MarketRequest,
  work: (auth: AuthenticationContext) => Promise<T>
): Promise<T> {
  req.res?.set({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  try {
    return await work(
      await getAuthenticationContext(req as unknown as Request)
    );
  } catch (error) {
    if (error instanceof ApiCompliantException) throw error;
    if (error instanceof z.ZodError)
      throw new BadRequestException('Invalid collecting or trade request.');
    if (error instanceof MarketValidationError)
      throw new CustomApiCompliantException(
        error.code === 'PROVIDER_UNAVAILABLE' ? 503 : 409,
        error.message,
        error.code
      );
    throw new CustomApiCompliantException(
      503,
      'The operation could not be verified. Refresh before trying again.',
      'MARKET_UNAVAILABLE'
    );
  } finally {
    // Order signatures are bearer capabilities; never forward bodies to telemetry.
    req.body = undefined;
  }
}
