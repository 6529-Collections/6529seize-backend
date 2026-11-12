import type { NextFunction, Request, Response } from 'express';
import { Logger } from '@/logging';
import { clientFamilyOf } from '@/api/auth/client-family';
import type { LegacyLoginFormat } from '@/api/auth/legacy-text-challenge';

// Usage of the legacy sign-in routes, so they can be switched off once no
// current client needs them: `/auth/login` by challenge format,
// `/auth/redeem-refresh-token` and the legacy desktop connection link, each
// by coarse client family and outcome. EMF lines on stdout (no CloudWatch API
// call or IAM change). Never records addresses, signatures, nonces or tokens.
//
// `Refusal` says why a call was refused, as its own dimension set so the
// Format and Client series stay as they were: `form_closed` for an old-form
// `/auth/login` challenge presented after its transition or last accepted
// day (an alarm can watch `Route=login, Refusal=form_closed`), `other` for
// any other refusal, `none` for an accepted call.

const NAMESPACE = '6529/Auth';
const FORMAT_LOCAL = 'legacyAuthFormat';
const REFUSAL_LOCAL = 'legacyAuthRefusal';
const logger = Logger.get('LEGACY_AUTH_METRICS');

export type LegacyAuthRoute =
  | 'login'
  | 'redeem_refresh_token'
  | 'legacy_desktop_link';

export type LegacyAuthFormat = LegacyLoginFormat | 'refresh_token';

export type LegacyAuthOutcome = 'ok' | 'refused';

export type LegacyAuthRefusal = 'none' | 'form_closed' | 'other';

export function recordLegacyAuthUse(record: {
  readonly route: LegacyAuthRoute;
  readonly format: LegacyAuthFormat;
  readonly userAgent: string | null | undefined;
  readonly outcome: LegacyAuthOutcome;
  readonly refusal?: LegacyAuthRefusal;
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
                ['Route', 'Client', 'Outcome'],
                ['Route', 'Refusal']
              ],
              Metrics: [{ Name: 'LegacyAuthCalls', Unit: 'Count' }]
            }
          ]
        },
        Route: record.route,
        Format: record.format,
        Client: clientFamilyOf(record.userAgent),
        Outcome: record.outcome,
        Refusal: record.refusal ?? (record.outcome === 'ok' ? 'none' : 'other'),
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
 * Marks a `/auth/login` refusal caused by an old-form challenge whose
 * transition or last accepted day has passed. Only read when the response
 * is a refusal.
 */
export function setLegacyLoginFormClosed(res: Response<any>): void {
  res.locals[REFUSAL_LOCAL] = 'form_closed';
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
      const refused = res.statusCode >= 400;
      recordLegacyAuthUse({
        route,
        format:
          res.locals[FORMAT_LOCAL] ??
          (route === 'login' ? 'unverified' : 'refresh_token'),
        userAgent,
        outcome: refused ? 'refused' : 'ok',
        refusal: refused ? (res.locals[REFUSAL_LOCAL] ?? 'other') : 'none'
      });
    });
    next();
  };
}
