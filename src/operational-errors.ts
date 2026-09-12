import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage<{
  requestId: string;
  observedErrors: WeakSet<Error>;
  reported?: boolean;
}>();
const token = (value: string | undefined, limit: number): string | undefined =>
  value && value.length <= limit && /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : undefined;

export function withOperationalContext<T>(
  requestId: string,
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
  code: 'APPLICATION_ERROR' | 'LAMBDA_FAILURE' = 'APPLICATION_ERROR'
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    const error = values.find(
      (value): value is Error => value instanceof Error
    );
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
    const fingerprint = createHash('sha256')
      .update(
        `${service}:${component}:${token(error?.name, 80) ?? 'Error'}:${code}`
      )
      .digest('hex');
    const correlationId = token(
      requestId ?? context.getStore()?.requestId,
      128
    );
    const release = token(process.env.GIT_SHA ?? process.env.COMMIT_HASH, 64);
    const envelope = {
      _type: '6529.ops.error.v1',
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      environment,
      service,
      severity: 'error',
      code,
      fingerprint,
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
