import { NextFunction, Request, Response } from 'express';
import { isCmsAgentRequest } from '@/api/profile-cms/profile-cms-agent.http';
import { ids } from '@/ids';
import { Logger } from '@/logging';
import { loggerContext } from '@/logger-context';
import { numbers } from '@/numbers';
import { Time, Timer } from '@/time';

const requestLogger = Logger.get('API_REQUEST');

export const REQUEST_ID_HEADER = 'X-Request-Id';

type ApiGatewayRequest = Request & {
  readonly apiGateway?: {
    readonly context?: { readonly awsRequestId?: string } | null;
  } | null;
};

/**
 * The Lambda request id when running behind API Gateway (it also appears in
 * the Lambda's own START/END log lines), otherwise a fresh short id. It is a
 * random server-side value and carries no user identifier.
 */
export function resolveRequestId(request: Request): string {
  return (
    (request as ApiGatewayRequest).apiGateway?.context?.awsRequestId ??
    ids.uniqueShortId()
  );
}

function isPrivateArchiveRequest(path: string): boolean {
  return (
    path.startsWith('/api/artwork-documentation') || isCmsAgentRequest(path)
  );
}

/**
 * Paths whose query strings are never written to the request log: private
 * archive and CMS agent routes, and the telemetry collector (`/api/e`).
 */
function shouldLogPathOnly(path: string): boolean {
  return (
    isPrivateArchiveRequest(path) ||
    path === '/api/e' ||
    path.startsWith('/api/e/')
  );
}

function getSlowRequestThreshold() {
  const slowRequestThresholdEnv = numbers.parseIntOrNull(
    process.env.SLOW_API_REQUEST_THRESHOLD
  );
  return slowRequestThresholdEnv
    ? Time.millis(slowRequestThresholdEnv)
    : Time.seconds(1);
}

/**
 * Gives every request an id, returns it as `X-Request-Id` on every response
 * and runs the request inside a logger context, so every server log line for
 * the request carries the same id. A user-sent diagnostics bundle can then be
 * matched to server logs without adding any user identifier to the logs.
 */
export function requestLogMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    const requestId = resolveRequestId(request);
    response.setHeader(REQUEST_ID_HEADER, requestId);
    if (isPrivateArchiveRequest(request.path)) {
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
      response.setHeader('X-Content-Type-Options', 'nosniff');
    }
    loggerContext.run({ requestId }, () => {
      const { method } = request;
      const url = shouldLogPathOnly(request.path)
        ? request.path
        : request.originalUrl;
      const uqKey = `${method} ${url}`;
      const timer = new Timer(uqKey);
      (request as any).timer = timer;
      response.on('close', () => {
        const { statusCode } = response;
        const tookMs = timer.getTotalTimePassed().toMillis();
        if (timer.getTotalTimePassed().gt(getSlowRequestThreshold())) {
          requestLogger.warn(
            `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${tookMs}] [${timer.getReport()}]`
          );
        } else {
          requestLogger.info(
            `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${tookMs}]`
          );
        }
      });
      next();
    });
  };
}
