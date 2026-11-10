import type { NextFunction, Request, Response } from 'express';
import { Logger } from '@/logging';
import { clientFamilyOf } from '@/api/auth/client-family';
import type { LegacyLoginFormat } from '@/api/auth/legacy-text-challenge';

// Usage of the legacy sign-in routes, so they can be switched off once no
// current client needs them: `/auth/login` by challenge format,
// `/auth/redeem-refresh-token` and the legacy desktop connection link, each
// by coarse client family and outcome. EMF lines on stdout (no CloudWatch API
// call or IAM change). Never records addresses, signatures, nonces or tokens.

const NAMESPACE = '6529/Auth';
const FORMAT_LOCAL = 'legacyAuthFormat';
const logger = Logger.get('LEGACY_AUTH_METRICS');

export type LegacyAuthRoute =
  | 'login'
  | 'redeem_refresh_token'
  | 'legacy_desktop_link';

export type LegacyAuthFormat = LegacyLoginFormat | 'refresh_token';

export type LegacyAuthOutcome = 'ok' | 'refused';

export function recordLegacyAuthUse(record: {
  readonly route: LegacyAuthRoute;
  readonly format: LegacyAuthFormat;
  readonly userAgent: string | null | undefined;
  readonly outcome: LegacyAuthOutcome;
}): void {
  try {
    process.stdout.write(
      `${JSON.stringify({
        _type: '6529.legacy_auth_use.v1',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [
                ['Route', 'Format', 'Outcome'],
                ['Route', 'Client', 'Outcome']
              ],
              Metrics: [{ Name: 'LegacyAuthCalls', Unit: 'Count' }]
            }
          ]
        },
        Route: record.route,
        Format: record.format,
        Client: clientFamilyOf(record.userAgent),
        Outcome: record.outcome,
        LegacyAuthCalls: 1
      })}\n`
    );
  } catch {
    // Telemetry must never change a request, not even through the logger
    // when stdout itself is failing.
    try {
      logger.error('Legacy auth usage metric could not be emitted');
    } catch {
      // Nothing left to report to.
    }
  }
}

/** The `/auth/login` challenge format, read when the response finishes. */
export function setLegacyLoginFormat(
  res: Response<any>,
  format: LegacyLoginFormat
): void {
  res.locals[FORMAT_LOCAL] = format;
}

/**
 * Middleware recording one use of `route` when its response finishes: `ok`
 * for a 2xx/3xx status, `refused` otherwise.
 */
export function recordLegacyAuthUseOnFinish(route: LegacyAuthRoute) {
  return (
    req: Request<any, any, any, any, any>,
    res: Response<any>,
    next: NextFunction
  ) => {
    const userAgent = req.headers['user-agent'];
    res.once('finish', () => {
      recordLegacyAuthUse({
        route,
        format:
          res.locals[FORMAT_LOCAL] ??
          (route === 'login' ? 'unverified' : 'refresh_token'),
        userAgent,
        outcome: res.statusCode < 400 ? 'ok' : 'refused'
      });
    });
    next();
  };
}
