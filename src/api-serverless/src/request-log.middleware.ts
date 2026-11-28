import { NextFunction, Request, Response } from 'express';
import { isCmsAgentRequest } from '@/api/profile-cms/profile-cms-agent.http';
import { ids } from '@/ids';
import { Logger } from '@/logging';
import { loggerContext, LoggerContextValue } from '@/logger-context';
import {
  emptyRequestSqlTotals,
  formatRequestSqlTotals
} from '@/db/sql-operation-timing';
import { numbers } from '@/numbers';
import { Time, Timer } from '@/time';

const requestLogger = Logger.get('API_REQUEST');

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** On a response that used an identity answered from the mirror's tables. */
export const IDENTITY_SOURCE_HEADER = 'X-6529-Identity-Source';

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
    (request as ApiGatewayRequest).apiGateway?.context?.awsRequestId ||
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
    const context: LoggerContextValue = {
      requestId,
      sql: emptyRequestSqlTotals()
    };
    loggerContext.run(context, () => {
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
        // Pool wait vs. execution of this request's SQL. Statements on a
        // transaction's connection add execution time but no pool wait.
        const sql = context.sql
          ? ` ${formatRequestSqlTotals(context.sql)}`
          : '';
        if (timer.getTotalTimePassed().gt(getSlowRequestThreshold())) {
          requestLogger.warn(
            `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${tookMs}]${sql} [${timer.getReport()}]`
          );
        } else {
          requestLogger.info(
            `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${tookMs}]${sql}`
          );
        }
      });
      next();
    });
  };
}

/**
 * `X-6529-Identity-Source: mirror` on a response that used an identity
 * lookup answered from the identity mirror's tables because the chain
 * gateway couldn't answer (ChainIdentityReads). Mounted right after
 * requestLogMiddleware, inside its logger context: it takes the request's
 * context here and reads it just before the headers go out (res.writeHead
 * wrapped, as the on-headers package does), when the lookups have run.
 */
export function identitySourceHeaderMiddleware() {
  return (_request: Request, response: Response, next: NextFunction) => {
    const context = loggerContext.get();
    if (context) {
      const writeHead = response.writeHead;
      response.writeHead = function (
        this: Response,
        ...args: Parameters<Response['writeHead']>
      ) {
        if (context.identitySource === 'mirror' && !this.headersSent) {
          this.setHeader(IDENTITY_SOURCE_HEADER, 'mirror');
        }
        return writeHead.apply(this, args);
      } as Response['writeHead'];
    }
    next();
  };
}
