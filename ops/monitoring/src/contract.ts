import { createHash } from 'node:crypto';

export const EVENT_TYPE = '6529.ops.error.v1';
export const MAX_EVENT_BYTES = 8192;
export type Environment = 'prod' | 'staging';
export type Severity = 'error' | 'critical' | 'recovery';
export type Code =
  | 'APPLICATION_ERROR'
  | 'LAMBDA_FAILURE'
  | 'PLATFORM_ALARM'
  | 'PLATFORM_RECOVERY'
  | 'SENTRY_ERROR'
  | 'UPTIME_FAILURE'
  | 'UPTIME_RECOVERY';
export interface Alert {
  _type: typeof EVENT_TYPE;
  eventId: string;
  occurredAt: string;
  environment: Environment;
  service: string;
  severity: Severity;
  code: Code;
  fingerprint: string;
  correlationId?: string;
  release?: string;
  sourceLink?: string;
}
const CODES = new Set<Code>([
  'APPLICATION_ERROR',
  'LAMBDA_FAILURE',
  'PLATFORM_ALARM',
  'PLATFORM_RECOVERY',
  'SENTRY_ERROR',
  'UPTIME_FAILURE',
  'UPTIME_RECOVERY'
]);
export const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function token(value: unknown, max = 128): string | undefined {
  return typeof value === 'string' &&
    value.length <= max &&
    /^[a-zA-Z0-9_.:/-]+$/.test(value)
    ? value
    : undefined;
}
export function parseAlert(input: unknown): Alert {
  const v = record(input);
  if (
    Buffer.byteLength(JSON.stringify(v)) > MAX_EVENT_BYTES ||
    v._type !== EVENT_TYPE ||
    !token(v.eventId, 180) ||
    !token(v.service, 100) ||
    !token(v.fingerprint, 128) ||
    !['prod', 'staging'].includes(String(v.environment)) ||
    !['error', 'critical', 'recovery'].includes(String(v.severity)) ||
    !CODES.has(v.code as Code) ||
    typeof v.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(v.occurredAt))
  )
    throw new Error('INVALID_ALERT');
  // Reconstruct an allowlist. Unknown fields, arbitrary messages and evidence never survive.
  const alert: Alert = {
    _type: EVENT_TYPE,
    eventId: v.eventId as string,
    occurredAt: new Date(v.occurredAt).toISOString(),
    environment: v.environment as Environment,
    service: v.service as string,
    severity: v.severity as Severity,
    code: v.code as Code,
    fingerprint: v.fingerprint as string
  };
  const correlationId = token(v.correlationId);
  const release = token(v.release, 64);
  if (correlationId) alert.correlationId = correlationId;
  if (release) alert.release = release;
  // Source links are constructed by trusted collectors, never accepted from producers.
  return alert;
}
export function renderAlert(alert: Alert, count = 1): object {
  const descriptions: Record<Code, string> = {
    APPLICATION_ERROR: 'Application reported an operational error.',
    LAMBDA_FAILURE: 'A Lambda invocation failed.',
    PLATFORM_ALARM: 'An infrastructure alarm entered ALARM state.',
    PLATFORM_RECOVERY: 'An infrastructure alarm recovered.',
    SENTRY_ERROR: 'Sentry reported an application error.',
    UPTIME_FAILURE: 'An independent endpoint check failed.',
    UPTIME_RECOVERY: 'An independent endpoint check recovered.'
  };
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${alert.environment} · ${alert.service} · ${alert.code}`,
        description: descriptions[alert.code],
        color: alert.severity === 'recovery' ? 0x22c55e : 0xef4444,
        fields: [
          { name: 'Occurrences', value: String(count), inline: true },
          { name: 'Event', value: alert.eventId },
          { name: 'Fingerprint', value: alert.fingerprint },
          ...(alert.correlationId
            ? [{ name: 'Correlation', value: alert.correlationId }]
            : []),
          ...(alert.release ? [{ name: 'Release', value: alert.release }] : [])
        ],
        timestamp: alert.occurredAt,
        ...(alert.sourceLink ? { url: alert.sourceLink } : {})
      }
    ]
  };
}
