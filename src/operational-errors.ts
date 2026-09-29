import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { ApiCompliantException } from '@/exceptions';

const CONDITIONS = [
  'SUBSCRIPTION_NOT_FOUND',
  'SUBSCRIPTION_BALANCE_NOT_FOUND',
  'SUBSCRIPTION_BALANCE_INSUFFICIENT',
  'PUSH_SENDER_MISMATCH',
  'PUSH_PROVIDER_TRANSIENT',
  'PUSH_DELIVERY_FAILED',
  'PUSH_RETRY_EXHAUSTED'
] as const;
export type OperationalCondition = (typeof CONDITIONS)[number];

export type FailureCategory =
  | 'HTTP_ERROR'
  | 'THROTTLED'
  | 'ACCESS_DENIED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'VALIDATION'
  | 'UNKNOWN';
export interface OperationalDiagnostic {
  category: FailureCategory;
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

const safeToken = (value: unknown, limit = 100): string | undefined =>
  typeof value === 'string' &&
  value.length <= limit &&
  /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : undefined;
function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}
function httpStatus(value: unknown): number | undefined {
  const status =
    property(value, 'status') ??
    property(property(value, '$metadata'), 'httpStatusCode');
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}
/** Fixed categories only: raw exception messages and logger arguments are never copied. */
function inferredDiagnostic(
  component: string,
  error: Error | undefined,
  values: readonly unknown[]
): OperationalDiagnostic {
  const ws = values.find(
    (value) => property(value, 'code') === 'WS_OUTBOUND_SEND_FAILED'
  );
  const wsStatus = property(ws, 'http_status');
  const status =
    httpStatus(error) ??
    (typeof wsStatus === 'number' &&
    Number.isInteger(wsStatus) &&
    wsStatus >= 100 &&
    wsStatus <= 599
      ? wsStatus
      : undefined);
  const code = property(error, 'code');
  const name = error?.name;
  let category: FailureCategory = 'UNKNOWN';
  if (status === 429) category = 'THROTTLED';
  else if (status === 401 || status === 403) category = 'ACCESS_DENIED';
  else if (status) category = 'HTTP_ERROR';
  else if (
    name === 'TimeoutError' ||
    name === 'RequestTimeout' ||
    code === 'ETIMEDOUT'
  )
    category = 'TIMEOUT';
  else if (['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(code)))
    category = 'NETWORK';
  else if (name === 'ValidationError') category = 'VALIDATION';
  return {
    category,
    operation: ws ? 'WS_OUTBOUND_SEND' : safeToken(component),
    ...(status ? { httpStatus: status } : {}),
    ...(typeof property(ws, 'sdk_attempts') === 'number' &&
    Number.isSafeInteger(property(ws, 'sdk_attempts')) &&
    (property(ws, 'sdk_attempts') as number) > 0 &&
    (property(ws, 'sdk_attempts') as number) <= 1000
      ? { sdkAttempts: property(ws, 'sdk_attempts') as number }
      : {})
  };
}
function safeDiagnostic(value: OperationalDiagnostic): OperationalDiagnostic {
  const categories: FailureCategory[] = [
    'HTTP_ERROR',
    'THROTTLED',
    'ACCESS_DENIED',
    'TIMEOUT',
    'NETWORK',
    'VALIDATION',
    'UNKNOWN'
  ];
  const category = categories.includes(value.category)
    ? value.category
    : 'UNKNOWN';
  const operation = safeToken(value.operation);
  const resource = safeToken(value.resource, 160);
  const provider = ['TRANSIENT', 'MANIFOLD', 'ALCHEMY', 'AWS'].includes(
    String(value.provider)
  )
    ? value.provider
    : undefined;
  const status = value.httpStatus;
  const httpStatus =
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined;
  const sdkAttempts =
    typeof value.sdkAttempts === 'number' &&
    Number.isSafeInteger(value.sdkAttempts) &&
    value.sdkAttempts > 0 &&
    value.sdkAttempts <= 1000
      ? value.sdkAttempts
      : undefined;
  const retry = value.recovery;
  const attempt = retry?.attempt;
  const maxAttempts = retry?.maxAttempts;
  const countsValid =
    Number.isSafeInteger(attempt) &&
    Number.isSafeInteger(maxAttempts) &&
    attempt! > 0 &&
    maxAttempts! > attempt! &&
    maxAttempts! <= 1000;
  const state =
    retry?.state === 'pending' && !countsValid ? 'unknown' : retry?.state;
  const recovery =
    state && ['pending', 'exhausted', 'terminal', 'unknown'].includes(state)
      ? {
          state,
          ...(Number.isSafeInteger(attempt) && attempt! > 0 ? { attempt } : {}),
          ...(Number.isSafeInteger(maxAttempts) && maxAttempts! > 0
            ? { maxAttempts }
            : {}),
          ...(state === 'pending' &&
          retry?.nextAttemptAt &&
          Number.isFinite(Date.parse(retry.nextAttemptAt))
            ? { nextAttemptAt: new Date(retry.nextAttemptAt).toISOString() }
            : {}),
          ...(state === 'unknown' &&
          retry?.nextEligibleAt &&
          Number.isFinite(Date.parse(retry.nextEligibleAt))
            ? { nextEligibleAt: new Date(retry.nextEligibleAt).toISOString() }
            : {})
        }
      : undefined;
  return {
    category,
    ...(operation ? { operation } : {}),
    ...(resource ? { resource } : {}),
    ...(provider ? { provider } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    ...(sdkAttempts ? { sdkAttempts } : {}),
    ...(recovery
      ? { recovery: recovery as OperationalDiagnostic['recovery'] }
      : {})
  };
}

export function isExpectedClientError(value: unknown): boolean {
  if (!(value instanceof ApiCompliantException)) return false;
  const status = value.getStatusCode();
  return status >= 400 && status < 500;
}

const context = new AsyncLocalStorage<{
  requestId: string | undefined;
  observedErrors: WeakSet<Error>;
  reported?: boolean;
}>();
const token = (value: string | undefined, limit: number): string | undefined =>
  value && value.length <= limit && /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : undefined;

export function withOperationalContext<T>(
  requestId: string | undefined,
  action: () => T
): T {
  return context.run(
    { requestId, observedErrors: new WeakSet<Error>() },
    action
  );
}

/** HTTP 5xx responses can resolve successfully without a thrown Lambda error. */
export function operationalResponse<T extends { statusCode: number }>(
  response: T
): T {
  if (response.statusCode >= 500 && !context.getStore()?.reported) {
    operationalError('HTTP_RESPONSE', []);
  }
  return response;
}

/** Emits metadata only. Exception messages, prompts, request bodies and identity are never copied. */
export function operationalError(
  component: string,
  values: readonly unknown[],
  requestId?: string,
  code: 'APPLICATION_ERROR' | 'LAMBDA_FAILURE' = 'APPLICATION_ERROR',
  condition?: OperationalCondition,
  diagnostic?: OperationalDiagnostic
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    const error = values.find(
      (value): value is Error => value instanceof Error
    );
    if (isExpectedClientError(error)) return;
    const observedErrors = context.getStore()?.observedErrors;
    if (error && observedErrors?.has(error)) return;
    const service = token(process.env.AWS_LAMBDA_FUNCTION_NAME, 100);
    if (!service) return;
    const configuredEnvironment = process.env.SENTRY_ENVIRONMENT ?? '';
    const environment =
      process.env.OPS_ENVIRONMENT === 'staging' ||
      configuredEnvironment === 'staging' ||
      configuredEnvironment.endsWith('_staging')
        ? 'staging'
        : 'prod';
    const discriminator = CONDITIONS.find((value) => value === condition) ?? '';
    const inferred = inferredDiagnostic(component, error, values);
    const detail = safeDiagnostic(
      diagnostic ? { ...inferred, ...diagnostic } : inferred
    );
    const fingerprint = createHash('sha256')
      .update(
        `${service}:${component}:${token(error?.name, 80) ?? 'Error'}:${code}:${discriminator}:${detail.category}:${detail.operation ?? ''}:${detail.provider ?? ''}:${detail.httpStatus ?? ''}:${detail.resource ?? ''}:${detail.recovery?.state ?? 'unknown'}`
      )
      .digest('hex');
    const correlationId = token(
      requestId ?? context.getStore()?.requestId,
      128
    );
    const release = token(
      process.env.GIT_COMMIT ?? process.env.GIT_SHA ?? process.env.COMMIT_HASH,
      64
    );
    const envelope = {
      _type: '6529.ops.error.v1',
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      environment,
      service,
      severity: 'error',
      code,
      fingerprint,
      diagnostic: detail,
      ...(discriminator.startsWith('PUSH_')
        ? { condition: discriminator }
        : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(release ? { release } : {})
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    const current = context.getStore();
    if (current) current.reported = true;
    if (error) observedErrors?.add(error);
  } catch {
    // Error reporting must not alter request/transaction behavior, even if stdout is unavailable.
  }
}
