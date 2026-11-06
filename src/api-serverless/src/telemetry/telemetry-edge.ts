import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/env';
import { getIp, normalizeIp } from '@/api/policies/policies';
import { Logger } from '@/logging';

const logger = Logger.get('TELEMETRY_EDGE');

/**
 * Viewer facts for telemetry requests.
 *
 * 6529.io/e reaches the API through CloudFront, so the API Gateway source IP
 * is a CloudFront edge address. CloudFront adds `CloudFront-Viewer-Address`
 * and `CloudFront-Viewer-Country`; those are trusted only when the request
 * also carries the secret edge header that the distribution adds as an
 * origin custom header (`TELEMETRY_EDGE_SECRET`). Direct calls to the API
 * fall back to the API Gateway source IP and an unknown country.
 *
 * The IP returned here is used in memory only (salted rate-limit key and the
 * daily uniques hash). It is never stored or logged.
 */
export interface TelemetryViewer {
  readonly ip: string;
  /** ISO 3166-1 alpha-2 code, or '' when unknown or untrusted. */
  readonly country: string;
  readonly viaEdge: boolean;
}

export const TELEMETRY_EDGE_SECRET_HEADER = 'x-6529-edge-auth';
const VIEWER_ADDRESS_HEADER = 'cloudfront-viewer-address';
const VIEWER_COUNTRY_HEADER = 'cloudfront-viewer-country';
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
// CloudFront uses XX when it cannot determine the country.
const UNKNOWN_COUNTRY = 'XX';

function headerValue(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

function secretsMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function isTrustedTelemetryEdge(req: Request): boolean {
  const secret = env.getStringOrNull('TELEMETRY_EDGE_SECRET');
  if (!secret) {
    return false;
  }
  return secretsMatch(secret, headerValue(req, TELEMETRY_EDGE_SECRET_HEADER));
}

/**
 * Once `TELEMETRY_EDGE_SECRET` is configured, every `/api/e` request must
 * come through the 6529.io edge: a missing or wrong secret header is answered
 * 403 before the body is read, and viewer headers are never trusted without
 * it. Without a configured secret (local development) requests pass, but
 * viewer headers are still ignored.
 */
export function requireTelemetryEdge() {
  return (req: Request, res: Response, next: NextFunction) => {
    // These routes end before the shared helmet middleware runs.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (
      !env.getStringOrNull('TELEMETRY_EDGE_SECRET') ||
      isTrustedTelemetryEdge(req)
    ) {
      next();
      return;
    }
    noteRejectedEdgeRequest();
    res.status(403).end();
  };
}

const REJECTION_LOG_INTERVAL_MS = 60_000;
let rejectedSinceLastLog = 0;
let lastRejectionLogMs = 0;

/**
 * At most one warning a minute per instance, with a count only, so an edge
 * secret that drifted between CloudFront and the API is visible without
 * logging anything about the rejected requests.
 */
function noteRejectedEdgeRequest() {
  rejectedSinceLastLog += 1;
  const now = Date.now();
  if (now - lastRejectionLogMs >= REJECTION_LOG_INTERVAL_MS) {
    logger.warn(
      `Telemetry edge guard rejected ${rejectedSinceLastLog} request(s) without a valid edge secret`
    );
    rejectedSinceLastLog = 0;
    lastRejectionLogMs = now;
  }
}

/**
 * `CloudFront-Viewer-Address` is `ip:port`; IPv6 addresses are not
 * bracketed, so the port is whatever follows the last colon.
 */
export function parseViewerAddress(value: string): string {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) {
    return '';
  }
  const host = value.slice(0, separator).replace(/^\[|\]$/g, '');
  return normalizeIp(host);
}

export function normalizeViewerCountry(value: string): string {
  const country = value.trim().toUpperCase();
  return COUNTRY_PATTERN.test(country) && country !== UNKNOWN_COUNTRY
    ? country
    : '';
}

export function getTelemetryViewer(req: Request): TelemetryViewer {
  if (isTrustedTelemetryEdge(req)) {
    return {
      ip: parseViewerAddress(headerValue(req, VIEWER_ADDRESS_HEADER)),
      country: normalizeViewerCountry(headerValue(req, VIEWER_COUNTRY_HEADER)),
      viaEdge: true
    };
  }
  return { ip: getIp(req), country: '', viaEdge: false };
}
