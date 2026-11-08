import { NextFunction, Request, Response } from 'express';
import { ApiCompliantException, apiCompliantErrorBody } from '@/exceptions';

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

export function customErrorMiddleware() {
  return (err: Error, _: Request, res: Response, next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      sendApiError(err, res);
      next();
    } else {
      res.status(500).send({ error: 'Something went wrong...' });
      next(err);
    }
  };
}
