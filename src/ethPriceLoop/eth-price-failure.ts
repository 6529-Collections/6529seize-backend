import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';

export type RepairStage =
  | 'insert-prices'
  | 'read-price-intervals'
  | 'update-transactions'
  | 'find-mint-tokens'
  | 'update-mint-totals';

/** Keep the original budget error available for adaptive sizing. */
export class EthPriceRepairError extends Error {
  constructor(
    readonly stage: RepairStage,
    readonly cause: unknown
  ) {
    super(`ETH price database repair failed during ${stage}`);
    this.name = 'EthPriceRepairError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function repairCause(error: unknown): unknown {
  return error instanceof EthPriceRepairError ? error.cause : error;
}

/**
 * Log diagnostic codes, never SQL text, parameters, or HTTP response bodies.
 * Free-text codes remain UNKNOWN: truncation cannot make arbitrary payloads safe.
 */
export function priceFailureDetails(error: unknown) {
  const cause = repairCause(error);
  const code =
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
      ? cause.code
      : undefined;
  return {
    stage: error instanceof EthPriceRepairError ? error.stage : undefined,
    code: code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN',
    ...(cause instanceof SqlExecutionBudgetExceededError
      ? {
          phase: cause.phase,
          commitOutcome: cause.commitOutcome,
          serverCode: cause.serverCode,
          connectionDestroyed: cause.connectionDestroyed
        }
      : {})
  };
}
