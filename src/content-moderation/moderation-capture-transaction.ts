import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SqlTransactionOptions } from '@/sql-executor';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { Logger } from '@/logging';

const logger = Logger.get('MODERATION_CAPTURE');
const CAPTURE_BUDGET_MS = 5000;
const FINALIZATION_RESERVE_MS = 500;

const SAFE_CODES = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_PARSE_ERROR',
  'ER_DUP_ENTRY',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE'
]);

/** Never export driver messages, SQL, or arbitrary driver properties. */
export function moderationDatabaseCode(error: unknown): string {
  if (error instanceof SqlExecutionBudgetExceededError) {
    if (error.code === 'SQL_BUDGET_EXCEEDED') return error.code;
    return SAFE_CODES.has(error.serverCode ?? '')
      ? error.serverCode!
      : 'UNKNOWN';
  }
  const code =
    error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'UNKNOWN';
}

/** Only standalone, database-only capture units may use this recovery policy. */
export async function runModerationCapture<T>(
  run: (options: SqlTransactionOptions) => Promise<T>
): Promise<T> {
  const deadline = performance.now() + CAPTURE_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      if (performance.now() + FINALIZATION_RESERVE_MS >= deadline)
        throw new SqlExecutionBudgetExceededError(
          'SQL_BUDGET_EXCEEDED',
          'ACQUIRE',
          'NOT_SENT'
        );
      return await run({
        executionBudget: {
          deadlineMonotonicMillis: deadline,
          maxStatementMillis: 1500,
          finalizationReserveMillis: FINALIZATION_RESERVE_MS,
          lockWaitSeconds: 1
        }
      });
    } catch (error) {
      // The budget owner awaits rollback and session restoration before rejecting.
      // Destruction (including lock-wait timeout), raw errors and ambiguous COMMIT
      // cannot prove that cleanup was acknowledged, so they are never replayed.
      const retry =
        error instanceof SqlExecutionBudgetExceededError &&
        error.code === 'SQL_STATEMENT_FAILED' &&
        error.serverCode === 'ER_LOCK_DEADLOCK' &&
        error.phase === 'WORK' &&
        error.commitOutcome === 'NOT_SENT' &&
        !error.connectionDestroyed &&
        attempt < 3 &&
        performance.now() + FINALIZATION_RESERVE_MS + 250 < deadline;
      logger.warn('Moderation capture transaction failed', {
        operation: 'capture_transaction',
        code: moderationDatabaseCode(error),
        attempt,
        retry,
        ...(error instanceof SqlExecutionBudgetExceededError
          ? { phase: error.phase, commit: error.commitOutcome }
          : {})
      });
      if (!retry) throw error;
      await delay(20 + Math.floor(Math.random() * 30));
    }
  }
}
