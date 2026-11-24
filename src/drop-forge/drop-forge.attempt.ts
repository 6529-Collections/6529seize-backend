import { randomBytes } from 'node:crypto';
import {
  LaunchAction,
  LaunchRecord,
  LaunchSafetyError,
  LaunchWalletBlockError
} from '@/drop-forge/drop-forge.types';
import { Logger } from '@/logging';

const logger = Logger.get('DROP_FORGE_LAUNCH');

const safeErrorReasons = new Map([
  ['ETIMEDOUT', 'Network request timed out'],
  ['TIMEOUT', 'Network request timed out'],
  ['TimeoutError', 'Network request timed out'],
  ['RequestTimeout', 'Network request timed out'],
  ['DependencyTimeoutException', 'AWS dependency timed out'],
  ['ECONNABORTED', 'Network connection aborted'],
  ['ECONNREFUSED', 'Network connection refused'],
  ['ECONNRESET', 'Network connection reset'],
  ['ENOTFOUND', 'Host name could not be resolved'],
  ['EAI_AGAIN', 'Host name lookup failed temporarily'],
  ['NETWORK_ERROR', 'RPC network error'],
  ['SERVER_ERROR', 'RPC server error'],
  ['CALL_EXCEPTION', 'Contract call or gas simulation reverted'],
  ['INSUFFICIENT_FUNDS', 'Operational wallet has insufficient ETH'],
  ['NONCE_EXPIRED', 'Transaction nonce was already used'],
  ['REPLACEMENT_UNDERPRICED', 'Replacement transaction fee was too low'],
  ['AccessDeniedException', 'AWS denied the request'],
  ['ThrottlingException', 'AWS throttled the request'],
  ['KMSInternalException', 'KMS returned an internal error'],
  ['KMSInvalidStateException', 'KMS key state rejected the operation'],
  ['DisabledException', 'KMS key is disabled'],
  ['InvalidKeyUsageException', 'KMS key usage rejected the operation'],
  ['NotFoundException', 'AWS resource was not found']
]);

type ProviderError = {
  code?: unknown;
  name?: unknown;
  cause?: { code?: unknown; name?: unknown };
  error?: { code?: unknown };
  info?: { error?: { code?: unknown }; responseStatus?: unknown };
  status?: unknown;
  statusCode?: unknown;
  $metadata?: { httpStatusCode?: unknown };
};

function errorDetails(error: unknown, reason: string) {
  if (error instanceof LaunchWalletBlockError)
    return { error_code: error.reason, reason: error.message };
  if (error instanceof LaunchSafetyError)
    return {
      error_code:
        error.message === 'RPC verification timed out'
          ? 'RPC_TIMEOUT'
          : error.name,
      reason: error.message.slice(0, 240)
    };
  if (error == null) return { reason };

  const providerError = error as ProviderError;
  const codes = [
    providerError.cause?.code,
    providerError.code,
    providerError.name,
    providerError.cause?.name
  ];
  const code = codes.find(
    (value): value is string =>
      typeof value === 'string' && safeErrorReasons.has(value)
  );
  const rpcCode = [
    providerError.info?.error?.code,
    providerError.error?.code,
    providerError.code
  ].find(
    (value): value is number =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value < 0 &&
      value >= -32768
  );
  const httpStatus = [
    providerError.$metadata?.httpStatusCode,
    providerError.status,
    providerError.statusCode,
    providerError.info?.responseStatus
  ].find(
    (value): value is number =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
  );
  // SDK exception messages can embed credentials, RPC payloads, or signed bytes.
  return {
    error_code: code ?? rpcCode,
    rpc_code: rpcCode,
    http_status: httpStatus,
    reason:
      (code ? safeErrorReasons.get(code) : undefined) ??
      (rpcCode === undefined
        ? 'Provider or SDK request failed'
        : 'JSON-RPC request failed')
  };
}

export class LaunchAttempt {
  private readonly startedAt = performance.now();
  private stepStartedAt = this.startedAt;

  constructor(
    private step: string,
    private lastCompletedStep?: string
  ) {}

  enter(step: string): void {
    this.lastCompletedStep = this.step;
    this.step = step;
    this.stepStartedAt = performance.now();
  }

  logFailure(
    record: LaunchRecord,
    action: LaunchAction,
    reason: string,
    error?: unknown
  ): string {
    const attemptId = randomBytes(6).toString('hex');
    const now = performance.now();
    logger.warn(
      JSON.stringify({
        event: 'drop_forge_attempt_failed',
        attempt_id: attemptId,
        claim_id: record.data.claim_id,
        launch_id: record.id,
        revision: record.revision,
        chain_id: record.data.chain_id,
        phase: action.phase,
        action_id: action.id,
        operation: action.kind,
        last_completed_step: this.lastCompletedStep,
        failed_step: this.step,
        elapsed_ms: Math.round(now - this.startedAt),
        failed_step_elapsed_ms: Math.round(now - this.stepStartedAt),
        ...errorDetails(error, reason)
      })
    );
    return attemptId;
  }
}
