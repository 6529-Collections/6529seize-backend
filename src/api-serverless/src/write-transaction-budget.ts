import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { ApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { SqlTransactionOptions } from '@/sql-executor';

/**
 * API write transactions (posts, reactions) must end well before the Lambda
 * does. A timed-out Lambda is frozen with its transaction still open and its
 * locks held until its environment is recycled (prod, 2026-11-07 20:20: one
 * stalled post held its wave's counter row and 28 requests timed out behind
 * it). Inside a request, such transactions run with an execution budget:
 * - lock waits give up after 10 s (`innodb_lock_wait_timeout`);
 * - at the request deadline (5 s before the Lambda's) the transaction is
 *   rolled back, or its connection destroyed if it cannot be.
 * Either way the request answers 503 with Retry-After, never a gateway
 * timeout. Outside a request (local server, tests, loops) nothing changes.
 */
export const WRITE_LOCK_WAIT_SECONDS = 10;
const RESPONSE_RESERVE_MS = 5_000;
const FINALIZATION_RESERVE_MS = 1_000;
const MAX_STATEMENT_MS = 15_000;
export const WRITE_BUSY_RETRY_AFTER_SECONDS = 2;

const logger = Logger.get('WRITE_TRANSACTION_BUDGET');
const requestDeadlines = new AsyncLocalStorage<{
  readonly deadlineMonotonicMillis: number;
}>();

/** Runs `work` with a write deadline `remainingMillis - 5 s` from now. */
export function withRequestDeadline<T>(
  remainingMillis: number,
  work: () => Promise<T>
): Promise<T> {
  return requestDeadlines.run(
    {
      deadlineMonotonicMillis:
        performance.now() + remainingMillis - RESPONSE_RESERVE_MS
    },
    work
  );
}

/**
 * COMMIT may or may not have happened. No Retry-After: retrying a post could
 * duplicate it, so the client should refetch first.
 */
export class WriteOutcomeUnknownException extends ApiCompliantException {
  constructor() {
    super(
      "We couldn't confirm that this was saved. Refresh before trying again.",
      'WRITE_OUTCOME_UNKNOWN'
    );
  }

  getStatusCode(): number {
    return 503;
  }
}

export class WriteBusyException extends ApiCompliantException {
  readonly retryAfterSeconds = WRITE_BUSY_RETRY_AFTER_SECONDS;

  constructor() {
    super('The server is busy. Please try again.', 'WRITE_BUSY');
  }

  getStatusCode(): number {
    return 503;
  }
}

function writeTransactionOptions(): SqlTransactionOptions | undefined {
  const scope = requestDeadlines.getStore();
  if (!scope) return undefined;
  const deadline = scope.deadlineMonotonicMillis;
  const left = deadline - performance.now();
  if (left <= FINALIZATION_RESERVE_MS + 100) throw new WriteBusyException();
  return {
    executionBudget: {
      deadlineMonotonicMillis: deadline,
      maxStatementMillis: Math.max(
        1,
        Math.min(MAX_STATEMENT_MS, Math.floor(left - FINALIZATION_RESERVE_MS))
      ),
      finalizationReserveMillis: FINALIZATION_RESERVE_MS,
      lockWaitSeconds: WRITE_LOCK_WAIT_SECONDS
    }
  };
}

/**
 * READ COMMITTED transaction options for paths that rely on it (votes, drop
 * delete), with the request's budget when there is one.
 */
export function readCommitted(
  options: SqlTransactionOptions | undefined
): SqlTransactionOptions {
  return {
    isolationLevel: 'READ COMMITTED',
    ...(options?.executionBudget
      ? { executionBudget: options.executionBudget }
      : {})
  };
}

/**
 * The budget gave up before COMMIT was sent: the write did not happen, so
 * the client may retry it.
 */
function isWriteBusy(error: unknown): boolean {
  if (error instanceof SqlExecutionBudgetExceededError) {
    return (
      error.commitOutcome === 'NOT_SENT' &&
      (error.code === 'SQL_BUDGET_EXCEEDED' ||
        error.serverCode === 'ER_LOCK_WAIT_TIMEOUT' ||
        error.serverCode === 'ER_LOCK_DEADLOCK')
    );
  }
  // Unbudgeted: a lock wait timeout fails a statement before any COMMIT, and
  // a deadlock victim's transaction is rolled back.
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ER_LOCK_WAIT_TIMEOUT' || code === 'ER_LOCK_DEADLOCK';
}

/** COMMIT may have been sent without an acknowledgment. */
function isOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof SqlExecutionBudgetExceededError &&
    error.commitOutcome !== 'NOT_SENT'
  );
}

/**
 * Two statements overlapped on the budgeted connection: rejected before
 * COMMIT, so the transaction rolled back. A write path that still issues
 * statements concurrently is a bug to fix; until then it runs unbudgeted.
 */
function isConcurrentStatements(error: unknown): boolean {
  return (
    error instanceof SqlExecutionBudgetExceededError &&
    error.code === 'SQL_CONCURRENT_STATEMENTS' &&
    error.commitOutcome === 'NOT_SENT'
  );
}

function budgetDetails(error: unknown) {
  return error instanceof SqlExecutionBudgetExceededError
    ? {
        code: error.code,
        phase: error.phase,
        commit: error.commitOutcome,
        server_code: error.serverCode ?? null,
        connection_destroyed: error.connectionDestroyed
      }
    : { code: (error as { code?: unknown } | null)?.code ?? null };
}

/**
 * Runs an API write transaction under the request's budget. `run` must pass
 * the options to `executeNativeQueriesInTransaction` and issue its
 * statements one at a time (a budgeted transaction rejects overlapping
 * statements on its connection).
 * - Gave up before COMMIT: 503 WRITE_BUSY with Retry-After.
 * - COMMIT outcome unknown: WRITE_OUTCOME_UNKNOWN, without Retry-After, so
 *   the client refetches instead of reposting.
 */
export async function runWriteTransaction<T>(
  run: (options: SqlTransactionOptions | undefined) => Promise<T>
): Promise<T> {
  const options = writeTransactionOptions();
  try {
    return await run(options);
  } catch (error) {
    if (options && isConcurrentStatements(error)) {
      logger.error('[WRITE_BUDGET_CONCURRENT_STATEMENTS] retrying unbudgeted');
      return runUnbudgeted(run);
    }
    if (isOutcomeUnknown(error)) {
      logger.error('[WRITE_OUTCOME_UNKNOWN]', budgetDetails(error));
      throw new WriteOutcomeUnknownException();
    }
    if (!isWriteBusy(error)) throw error;
    logger.warn('Write transaction gave up', {
      budgeted: !!options?.executionBudget,
      ...budgetDetails(error)
    });
    throw new WriteBusyException();
  }
}

async function runUnbudgeted<T>(
  run: (options: SqlTransactionOptions | undefined) => Promise<T>
): Promise<T> {
  try {
    return await run(undefined);
  } catch (error) {
    if (!isWriteBusy(error)) throw error;
    throw new WriteBusyException();
  }
}
