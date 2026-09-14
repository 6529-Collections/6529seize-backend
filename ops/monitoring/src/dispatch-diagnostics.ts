import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const stages = [
  'PARSE',
  'RESERVE',
  'GROUP',
  'DIGEST_READ',
  'DIGEST_PLAN',
  'DIGEST_FALLBACK',
  'SCHEDULE',
  'RATE_SLOT',
  'SECRET',
  'WEBHOOK',
  'WEBHOOK_EDIT',
  'COMPLETE',
  'RELEASE',
  'HEARTBEAT',
  'ARCHIVE',
  'FALLBACK'
] as const;
export type DispatchStage = (typeof stages)[number];
const outcomes = [
  'DELIVERED',
  'EDITED',
  'GROUPED',
  'HEARTBEAT',
  'NO_REPEAT',
  'ARCHIVED',
  'ALREADY_COMPLETE',
  'INVALID_ARCHIVED'
] as const;
type DispatchOutcome = (typeof outcomes)[number];
const deliveryCauses = [
  'HTTP_RATE_LIMIT',
  'HTTP_RETRYABLE_STATUS',
  'HTTP_PERMANENT_STATUS',
  'TRANSPORT_TIMEOUT',
  'TRANSPORT_OTHER',
  'INVALID_DELIVERY_RESPONSE',
  'INVALID_DELIVERY_CONFIGURATION',
  'DELIVERY_DESTINATION_CHANGED'
] as const;
export interface DeliveryErrorDetails {
  cause: (typeof deliveryCauses)[number];
  httpStatus?: number;
}
const cancellationCodes = [
  'None',
  'ConditionalCheckFailed',
  'TransactionConflict',
  'ProvisionedThroughputExceeded',
  'ThrottlingError',
  'ValidationError',
  'ItemCollectionSizeLimitExceeded'
] as const;
type CancellationCode = (typeof cancellationCodes)[number] | 'UNKNOWN';
type Cause =
  | DeliveryErrorDetails['cause']
  | 'DDB_TRANSACTION_CONFLICT'
  | 'DDB_THROTTLED'
  | 'DDB_CONDITION'
  | 'AWS_THROTTLED'
  | 'AWS_ACCESS_DENIED'
  | 'AWS_VALIDATION'
  | 'AWS_OTHER'
  | 'UNKNOWN';
interface FailureSummary {
  operation: DispatchStage | 'UNKNOWN';
  cause: Cause;
  httpStatus?: number;
  retryAfterSeconds?: number;
  sdkAttempts?: number;
  cancellationCodes?: CancellationCode[];
}
interface Failure {
  error: unknown;
  summary: FailureSummary;
}
interface DispatchState {
  lane: 'normal' | 'critical' | 'UNKNOWN';
  kind?: 'alert' | 'digest' | 'heartbeat';
  sqsMessageHash?: string;
  workHash?: string;
  receiveCount?: number;
  startedAt: number;
  deliveryAcceptance: 'NOT_ATTEMPTED' | 'UNKNOWN' | 'CONFIRMED';
  primary?: Failure;
  cleanup?: Failure;
}
interface TraceFrame {
  failure?: Failure;
}
interface Scope {
  state: DispatchState;
  frame?: TraceFrame;
}
const context = new AsyncLocalStorage<Scope>();

// Do not invoke getters or stringify arbitrary objects, even on error paths.
function property(value: unknown, key: string): unknown {
  try {
    let current = value;
    for (let depth = 0; depth < 4; depth++) {
      if (current === null || typeof current !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor)
        return 'value' in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    /* Unknown SDK shapes and revoked proxies are intentionally opaque. */
  }
  return undefined;
}
function member<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  return typeof value === 'string'
    ? allowed.find((item) => item === value)
    : undefined;
}
function bounded(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? Math.min(maximum, Math.floor(value))
    : undefined;
}
function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}
function messageHash(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? createHash('sha256').update(value).digest('hex')
    : undefined;
}
function receiveCount(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d{1,9}$/.test(value)
    ? bounded(Number(value), 1, 1000000)
    : undefined;
}
function cancellationDetails(error: unknown): CancellationCode[] | undefined {
  const reasons = property(error, 'CancellationReasons');
  try {
    if (!Array.isArray(reasons)) return undefined;
    const count = bounded(property(reasons, 'length'), 0, 2) ?? 0;
    const result: CancellationCode[] = [];
    for (let index = 0; index < count; index++) {
      result.push(
        member(
          property(property(reasons, String(index)), 'Code'),
          cancellationCodes
        ) ?? 'UNKNOWN'
      );
    }
    return result;
  } catch {
    return undefined;
  }
}
function sdkCause(
  name: unknown,
  codes?: CancellationCode[],
  reasonCount?: unknown
): Cause {
  if (name === 'TransactionCanceledException') {
    if (reasonCount !== 2) return 'AWS_OTHER';
    if (
      codes?.length === 2 &&
      codes.includes('TransactionConflict') &&
      codes.every((code) => code === 'None' || code === 'TransactionConflict')
    )
      return 'DDB_TRANSACTION_CONFLICT';
    if (
      codes?.some(
        (code) =>
          code === 'ProvisionedThroughputExceeded' || code === 'ThrottlingError'
      )
    )
      return 'DDB_THROTTLED';
    return 'AWS_OTHER';
  }
  if (name === 'ConditionalCheckFailedException') return 'DDB_CONDITION';
  if (name === 'ProvisionedThroughputExceededException') return 'DDB_THROTTLED';
  if (
    name === 'ThrottlingException' ||
    name === 'Throttling' ||
    name === 'RequestLimitExceeded' ||
    name === 'TooManyRequestsException'
  )
    return 'AWS_THROTTLED';
  if (
    name === 'AccessDenied' ||
    name === 'AccessDeniedException' ||
    name === 'UnauthorizedOperation'
  )
    return 'AWS_ACCESS_DENIED';
  if (name === 'ValidationException' || name === 'ValidationError')
    return 'AWS_VALIDATION';
  return 'UNKNOWN';
}
function summarize(
  error: unknown,
  operation: FailureSummary['operation']
): FailureSummary {
  const details = property(error, 'details');
  const sdk = property(error, '$metadata');
  const name = property(error, 'name');
  const codes =
    name === 'TransactionCanceledException'
      ? cancellationDetails(error)
      : undefined;
  return {
    operation,
    cause:
      member(property(details, 'cause'), deliveryCauses) ??
      sdkCause(
        name,
        codes,
        property(property(error, 'CancellationReasons'), 'length')
      ),
    httpStatus:
      httpStatus(property(details, 'httpStatus')) ??
      httpStatus(property(sdk, 'httpStatusCode')),
    retryAfterSeconds: bounded(property(error, 'retryAfterSeconds'), 0, 43200),
    sdkAttempts: bounded(property(sdk, 'attempts'), 1, 100),
    cancellationCodes: codes
  };
}

export function withDispatchDiagnostics<T>(
  input: { lane: string; messageId: string; receiveCount?: string },
  run: () => Promise<T>
): Promise<T> {
  let scope: Scope;
  try {
    scope = {
      state: {
        lane:
          member(property(input, 'lane'), ['normal', 'critical']) ?? 'UNKNOWN',
        sqsMessageHash: messageHash(property(input, 'messageId')),
        receiveCount: receiveCount(property(input, 'receiveCount')),
        startedAt: Date.now(),
        deliveryAcceptance: 'NOT_ATTEMPTED'
      }
    };
  } catch {
    return run();
  }
  return context.run(scope, run);
}

export async function traceDispatch<T>(
  stage: DispatchStage,
  run: () => Promise<T>
): Promise<T> {
  const scope = context.getStore();
  if (!scope) return run();
  const frame: TraceFrame = {};
  try {
    return await context.run({ state: scope.state, frame }, run);
  } catch (error) {
    try {
      const failure =
        frame.failure && frame.failure.error === error
          ? frame.failure
          : {
              error,
              summary: summarize(error, member(stage, stages) ?? 'UNKNOWN')
            };
      if (scope.frame) {
        scope.frame.failure = failure;
      } else if (
        scope.state.primary &&
        (stage === 'RELEASE' || stage === 'ARCHIVE' || stage === 'FALLBACK')
      ) {
        scope.state.cleanup ??= failure;
      } else {
        scope.state.primary = failure;
        scope.state.cleanup = undefined;
      }
    } catch {
      /* Diagnostics must never replace the original thrown value. */
    }
    throw error;
  }
}
export function bindDispatchWork(
  kind: 'alert' | 'digest' | 'heartbeat',
  workHash: string
): void {
  const state = context.getStore()?.state;
  if (!state) return;
  state.kind = member(kind, ['alert', 'digest', 'heartbeat']);
  if (typeof workHash === 'string' && /^[a-f0-9]{64}$/.test(workHash))
    state.workHash = workHash;
}
export function webhookAttempted(): void {
  const state = context.getStore()?.state;
  if (state) state.deliveryAcceptance = 'UNKNOWN';
}
export function webhookAccepted(): void {
  const state = context.getStore()?.state;
  if (state) state.deliveryAcceptance = 'CONFIRMED';
}
function common(state?: DispatchState): object {
  return {
    schemaVersion: 1,
    lane: state?.lane ?? 'UNKNOWN',
    kind: state?.kind,
    sqsMessageHash: state?.sqsMessageHash,
    workHash: state?.workHash,
    receiveCount: state?.receiveCount,
    elapsedMs: state
      ? bounded(Date.now() - state.startedAt, 0, 86400000)
      : undefined,
    deliveryAcceptance: state?.deliveryAcceptance ?? 'NOT_ATTEMPTED'
  };
}
export function completeDispatch(outcome: DispatchOutcome): void {
  try {
    const state = context.getStore()?.state;
    if (!state) return;
    const safeOutcome = member(outcome, outcomes);
    if (!safeOutcome) return;
    console.log(
      JSON.stringify({
        code: 'DELIVERY_SETTLED',
        ...common(state),
        outcome: safeOutcome
      })
    );
  } catch {
    /* Logging cannot change receipt acknowledgement. */
  }
}
export function logDispatchFailure(error: unknown): void {
  try {
    const state = context.getStore()?.state;
    const matches =
      state?.primary?.error === error || state?.cleanup?.error === error;
    const primary = matches ? state?.primary?.summary : undefined;
    console.error(
      JSON.stringify({
        code: 'DELIVERY_FAILED',
        ...common(state),
        ...(primary ?? summarize(error, 'UNKNOWN')),
        cleanup: matches ? state?.cleanup?.summary : undefined
      })
    );
  } catch {
    /* Logging cannot replace the original processing failure. */
  }
}
