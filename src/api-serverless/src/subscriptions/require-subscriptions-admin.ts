import { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticateSubscriptionsAdmin } from '@/api/subscriptions/api.subscriptions.allowlist';
import { ForbiddenException } from '@/exceptions';

type DeniedExceptionConstructor = new (message: string) => Error;

/**
 * Route guard for Subscription Admin only endpoints.
 *
 * Register it after `needsAuthenticatedUser()` and BEFORE `cacheRequest()`.
 * `cacheRequest()` answers from the cache before the route handler runs, so an
 * admin check performed inside the handler is skipped for every cache hit.
 */
export function requireSubscriptionsAdmin(
  deniedMessage: string,
  DeniedException: DeniedExceptionConstructor = ForbiddenException
): RequestHandler<any, any, any, any, any> {
  return (
    req: Request<any, any, any, any, any>,
    _res: Response<any, any>,
    next: NextFunction
  ) => {
    if (!authenticateSubscriptionsAdmin(req)) {
      next(new DeniedException(deniedMessage));
      return;
    }
    next();
  };
}
