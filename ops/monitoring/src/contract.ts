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
export interface AlarmMetadata {
  name?: string;
  namespace?: string;
  metric?: string;
  statistic?: string;
  periodSeconds?: number;
  threshold?: number;
}
export interface Diagnostic {
  category:
    | 'HTTP_ERROR'
    | 'THROTTLED'
    | 'ACCESS_DENIED'
    | 'TIMEOUT'
    | 'NETWORK'
    | 'VALIDATION'
    | 'UNKNOWN';
  operation?: string;
  resource?: string;
  provider?: 'TRANSIENT' | 'MANIFOLD' | 'ALCHEMY' | 'AWS';
  httpStatus?: number;
  sdkAttempts?: number;
  recovery?: {
    state: 'pending' | 'exhausted' | 'terminal' | 'unknown';
    attempt?: number;
    maxAttempts?: number;
    nextAttemptAt?: string;
    nextEligibleAt?: string;
  };
}
const CATEGORIES = new Set<Diagnostic['category']>([
  'HTTP_ERROR',
  'THROTTLED',
  'ACCESS_DENIED',
  'TIMEOUT',
  'NETWORK',
  'VALIDATION',
  'UNKNOWN'
]);
const PROVIDERS = new Set<NonNullable<Diagnostic['provider']>>([
  'TRANSIENT',
  'MANIFOLD',
  'ALCHEMY',
  'AWS'
]);
function diagnosticToken(value: unknown, max = 100): string | undefined {
  return typeof value === 'string' &&
    value.length <= max &&
    /^[A-Za-z0-9_.:-]+$/.test(value) &&
    !value.includes('://')
    ? value
    : undefined;
}
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 1000
    ? value
    : undefined;
}
function validDate(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}
function parseRecovery(input: unknown): Diagnostic['recovery'] {
  const value = record(input);
  const states = ['pending', 'exhausted', 'terminal', 'unknown'] as const;
  if (!states.includes(value.state as (typeof states)[number]))
    return undefined;
  const attempt = positiveInt(value.attempt);
  const maxAttempts = positiveInt(value.maxAttempts);
  const pending =
    value.state === 'pending' &&
    attempt !== undefined &&
    maxAttempts !== undefined &&
    attempt < maxAttempts;
  let state = value.state as NonNullable<Diagnostic['recovery']>['state'];
  if (state === 'pending' && !pending) state = 'unknown';
  const result: NonNullable<Diagnostic['recovery']> = { state };
  if (attempt) result.attempt = attempt;
  if (maxAttempts) result.maxAttempts = maxAttempts;
  const nextAttemptAt = pending ? validDate(value.nextAttemptAt) : undefined;
  const nextEligibleAt =
    state === 'unknown' ? validDate(value.nextEligibleAt) : undefined;
  if (nextAttemptAt) result.nextAttemptAt = nextAttemptAt;
  if (nextEligibleAt) result.nextEligibleAt = nextEligibleAt;
  return result;
}
export function parseDiagnostic(input: unknown): Diagnostic | undefined {
  const v = record(input);
  if (!CATEGORIES.has(v.category as Diagnostic['category'])) return undefined;
  const diagnostic: Diagnostic = {
    category: v.category as Diagnostic['category']
  };
  diagnostic.operation = diagnosticToken(v.operation);
  diagnostic.resource = diagnosticToken(v.resource, 160);
  if (PROVIDERS.has(v.provider as NonNullable<Diagnostic['provider']>))
    diagnostic.provider = v.provider as Diagnostic['provider'];
  if (
    typeof v.httpStatus === 'number' &&
    Number.isInteger(v.httpStatus) &&
    v.httpStatus >= 100 &&
    v.httpStatus <= 599
  )
    diagnostic.httpStatus = v.httpStatus;
  const sdkAttempts = positiveInt(v.sdkAttempts);
  if (sdkAttempts) diagnostic.sdkAttempts = sdkAttempts;
  diagnostic.recovery = parseRecovery(v.recovery);
  return diagnostic;
}
const CONDITIONS = [
  'PUSH_SENDER_MISMATCH',
  'PUSH_PROVIDER_TRANSIENT',
  'PUSH_DELIVERY_FAILED',
  'PUSH_RETRY_EXHAUSTED'
] as const;
type Condition = (typeof CONDITIONS)[number];

export interface Alert {
  _type: typeof EVENT_TYPE;
  eventId: string;
  occurredAt: string;
  environment: Environment;
  service: string;
  severity: Severity;
  code: Code;
  fingerprint: string;
  condition?: Condition;
  correlationId?: string;
  release?: string;
  alarm?: AlarmMetadata;
  diagnostic?: Diagnostic;
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
export function parseAlarmMetadata(input: unknown): AlarmMetadata | undefined {
  const v = record(input);
  const alarm: AlarmMetadata = {};
  for (const key of ['name', 'namespace', 'metric', 'statistic'] as const) {
    const value = token(v[key], key === 'name' ? 255 : 128);
    if (value && !value.includes(':')) alarm[key] = value;
  }
  if (
    typeof v.periodSeconds === 'number' &&
    Number.isInteger(v.periodSeconds) &&
    v.periodSeconds > 0 &&
    v.periodSeconds <= 86400
  )
    alarm.periodSeconds = v.periodSeconds;
  if (typeof v.threshold === 'number' && Number.isFinite(v.threshold))
    alarm.threshold = v.threshold;
  return Object.keys(alarm).length ? alarm : undefined;
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
  const condition = CONDITIONS.find((value) => value === v.condition);
  if (condition) alert.condition = condition;
  const correlationId = token(v.correlationId);
  const release = token(v.release, 64);
  if (correlationId) alert.correlationId = correlationId;
  if (release) alert.release = release;
  if (['APPLICATION_ERROR', 'LAMBDA_FAILURE'].includes(alert.code))
    alert.diagnostic = parseDiagnostic(v.diagnostic);
  if (['PLATFORM_ALARM', 'PLATFORM_RECOVERY'].includes(alert.code)) {
    const alarm = parseAlarmMetadata(v.alarm);
    if (alarm) alert.alarm = alarm;
  }
  return alert;
}
function alarmFields(alarm: AlarmMetadata | undefined) {
  if (!alarm) return [];
  const labels: Record<keyof AlarmMetadata, string> = {
    name: 'Alarm',
    namespace: 'Namespace',
    metric: 'Metric',
    statistic: 'Statistic',
    periodSeconds: 'Period (seconds)',
    threshold: 'Datapoint threshold'
  };
  return (Object.keys(labels) as (keyof AlarmMetadata)[]).flatMap((key) =>
    alarm[key] === undefined
      ? []
      : [{ name: labels[key], value: String(alarm[key]) }]
  );
}
const DESCRIPTIONS: Record<Code, string> = {
  APPLICATION_ERROR:
    'Application operation failed; recovery status is unknown.',
  LAMBDA_FAILURE: 'Lambda invocation failed; recovery status is unknown.',
  PLATFORM_ALARM: 'An infrastructure alarm entered ALARM state.',
  PLATFORM_RECOVERY: 'An infrastructure alarm recovered.',
  SENTRY_ERROR: 'Sentry reported an application error.',
  UPTIME_FAILURE: 'An independent endpoint check failed.',
  UPTIME_RECOVERY: 'An independent endpoint check recovered.'
};
const CATEGORY_TEXT: Record<Diagnostic['category'], string> = {
  HTTP_ERROR: 'HTTP request failed',
  THROTTLED: 'provider throttled the request',
  ACCESS_DENIED: 'provider denied access',
  TIMEOUT: 'operation timed out',
  NETWORK: 'network request failed',
  VALIDATION: 'validation failed',
  UNKNOWN: 'unclassified failure'
};
const CONDITION_TEXT: Record<Condition, string> = {
  PUSH_SENDER_MISMATCH: 'push sender credentials mismatch',
  PUSH_PROVIDER_TRANSIENT: 'push provider reported a transient failure',
  PUSH_DELIVERY_FAILED: 'push delivery failed',
  PUSH_RETRY_EXHAUSTED: 'push delivery retries exhausted'
};
function isAmber(alert: Alert): boolean {
  const d = alert.diagnostic;
  return (
    alert.severity === 'error' &&
    d?.recovery?.state === 'pending' &&
    d.category !== 'ACCESS_DENIED' &&
    d.category !== 'VALIDATION'
  );
}
function failureCause(alert: Alert, d: Diagnostic): string {
  if (d.httpStatus)
    return `${d.provider ?? 'Provider'} returned HTTP ${d.httpStatus}`;
  if (d.category === 'UNKNOWN' && alert.condition)
    return CONDITION_TEXT[alert.condition];
  return CATEGORY_TEXT[d.category];
}
function recoverySentence(d: Diagnostic, amber: boolean): string {
  if (amber) return 'An automatic retry is pending.';
  switch (d.recovery?.state) {
    case 'pending':
      return 'A retry is pending, but this failure requires investigation.';
    case 'exhausted':
      return 'Retries are exhausted; investigation required.';
    case 'terminal':
      return 'Terminal failure; investigation required.';
    default:
      return 'Recovery status is unknown; investigation required.';
  }
}
function alertDescription(alert: Alert, amber: boolean): string {
  const d = alert.diagnostic;
  if (!d) return DESCRIPTIONS[alert.code];
  let operation = d.operation ?? alert.service;
  if (operation === 'NFT_REFRESH') operation = 'NFT refresh';
  if (operation === 'WS_OUTBOUND_SEND') operation = 'WebSocket send';
  return `${operation} failed: ${failureCause(alert, d)}. ${recoverySentence(d, amber)}`;
}
interface AlertField {
  name: string;
  value: string;
  inline?: boolean;
}
function diagnosticFields(
  d: Diagnostic | undefined,
  count: number
): AlertField[] {
  if (!d) return [];
  const fields: AlertField[] = [];
  if (d.resource)
    fields.push({
      name:
        d.operation === 'NFT_REFRESH' ? 'Affected NFT' : 'Affected resource',
      value: d.resource
    });
  if (count === 1 && d.sdkAttempts)
    fields.push({
      name: 'SDK attempts completed',
      value: String(d.sdkAttempts)
    });
  const recovery = d.recovery;
  if (count === 1 && recovery?.attempt) {
    let value = String(recovery.attempt);
    if (recovery.maxAttempts) value += ` of ${recovery.maxAttempts}`;
    fields.push({ name: 'Attempt', value });
  }
  if (count === 1 && recovery?.nextAttemptAt)
    fields.push({
      name: 'Retry',
      value: `Pending at ${recovery.nextAttemptAt}`
    });
  if (count === 1 && recovery?.nextEligibleAt)
    fields.push({
      name: 'Retry',
      value: `Eligible after ${recovery.nextEligibleAt} when requested; no attempt scheduled`
    });
  return fields;
}
function alertFields(alert: Alert, count: number): AlertField[] {
  const fields: AlertField[] = [
    { name: 'Occurrences', value: String(count), inline: true },
    ...diagnosticFields(alert.diagnostic, count),
    ...alarmFields(alert.alarm)
  ];
  if (alert.condition)
    fields.push({ name: 'Condition', value: alert.condition });
  fields.push(
    { name: 'Event', value: alert.eventId },
    { name: 'Fingerprint', value: alert.fingerprint }
  );
  if (alert.correlationId)
    fields.push({ name: 'Correlation', value: alert.correlationId });
  if (alert.release) fields.push({ name: 'Release', value: alert.release });
  return fields;
}
export function renderAlert(alert: Alert, count = 1): object {
  const amber = isAmber(alert);
  let color = 0xef4444;
  if (amber) {
    color = 0xf59e0b;
  }
  if (alert.severity === 'recovery') {
    color = 0x22c55e;
  }
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${alert.environment} · ${alert.service} · ${alert.code}`,
        description: alertDescription(alert, amber),
        color,
        fields: alertFields(alert, count),
        timestamp: alert.occurredAt
      }
    ]
  };
}
