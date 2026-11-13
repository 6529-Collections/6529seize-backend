import { NextFunction, Request, Response } from 'express';
import {
  ApiCompliantException,
  apiCompliantErrorBody,
  BadRequestException
} from '@/exceptions';
import { SqlParameterValueError } from '@/db/sql-named-parameters';

/**
 * Maps API errors to responses. An error with `retryAfterSeconds` (such as
 * a write that gave up on a lock) also sends Retry-After.
 */
/** Sends an API error, with Retry-After when it carries retryAfterSeconds. */
export function sendApiError(err: ApiCompliantException, res: Response): void {
  const retryAfter = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof retryAfter === 'number') {
    res.set('Retry-After', String(retryAfter));
  }
  res.status(err.getStatusCode()).send(apiCompliantErrorBody(err));
}

/**
 * The API error to send for err, or null for an unexpected error. A request
 * value that reached SQL in an unsupported shape is answered as a 400.
 */
export function toApiCompliantError(
  err: unknown
): ApiCompliantException | null {
  if (err instanceof ApiCompliantException) {
    return err;
  }
  if (err instanceof SqlParameterValueError) {
    return new BadRequestException('Invalid request parameter');
  }
  return null;
}

export function customErrorMiddleware() {
  return (err: Error, _: Request, res: Response, next: NextFunction) => {
    const apiError = toApiCompliantError(err);
    if (apiError) {
      sendApiError(apiError, res);
      next();
    } else {
      res.status(500).send({ error: 'Something went wrong...' });
      next(err);
    }
  };
}
