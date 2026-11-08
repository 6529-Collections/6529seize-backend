import { NextFunction, Request, Response } from 'express';
import { ApiCompliantException, apiCompliantErrorBody } from '@/exceptions';

/**
 * Maps API errors to responses. An error with `retryAfterSeconds` (such as
 * a write that gave up on a lock) also sends Retry-After.
 */
export function customErrorMiddleware() {
  return (err: Error, _: Request, res: Response, next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      const retryAfter = (err as { retryAfterSeconds?: unknown })
        .retryAfterSeconds;
      if (typeof retryAfter === 'number') {
        res.set('Retry-After', String(retryAfter));
      }
      res.status(err.getStatusCode()).send(apiCompliantErrorBody(err));
      next();
    } else {
      res.status(500).send({ error: 'Something went wrong...' });
      next(err);
    }
  };
}
