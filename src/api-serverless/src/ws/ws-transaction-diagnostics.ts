import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  logWebSocketDiagnostic,
  webSocketDiagnosticMetadata,
  WsDiagnosticOperation
} from '@/api/ws/ws-operation-diagnostics';

type Phase =
  | 'acquisition'
  | 'lock_connection'
  | 'insert_connection'
  | 'update_identity'
  | 'delete_subscriptions'
  | 'insert_subscriptions'
  | 'delete_connection'
  | 'cleanup_expired'
  | 'cleanup_orphans'
  | 'commit';
type Owner = 'repository' | 'caller' | 'autocommit';
const attempts = new AsyncLocalStorage<WsTransactionDiagnostics>();
const errorCodes = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_DUP_ENTRY',
  'ER_RECORD_FILE_FULL',
  'ER_QUERY_INTERRUPTED',
  'ER_QUERY_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT'
]);

function property(value: unknown, key: string): unknown {
  try {
    return value && typeof value === 'object'
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}
function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function errorMetadata(error: unknown) {
  const code = property(error, 'code');
  const state = property(error, 'sqlState');
  return {
    mysql_code:
      typeof code === 'string' && errorCodes.has(code) ? code : 'OTHER',
    mysql_errno: safeInteger(property(error, 'errno')),
    mysql_sqlstate:
      typeof state === 'string' && /^[0-9A-Z]{5}$/.test(state) ? state : null
  };
}

export function recordWebSocketSqlPhase(phase: Phase): void {
  const current = attempts.getStore();
  if (current) current.phase = phase;
}

/** Read only metadata projected by the existing locking SELECT, never row values. */
export function recordWebSocketDatabaseSession(row: unknown): void {
  const current = attempts.getStore();
  if (!current) return;
  current.sessionId = safeInteger(property(row, 'diagnostic_session_id'));
  const isolation = property(row, 'diagnostic_isolation');
  if (
    isolation === 'REPEATABLE-READ' ||
    isolation === 'READ-COMMITTED' ||
    isolation === 'SERIALIZABLE' ||
    isolation === 'READ-UNCOMMITTED'
  )
    current.isolation = isolation;
}

export class WsTransactionDiagnostics {
  private readonly metadata;
  private readonly mutationId = randomUUID();
  private readonly started = performance.now();
  private attemptStarted = this.started;
  private attempt = 1;
  phase: Phase = 'acquisition';
  sessionId: number | null = null;
  isolation: string | null = null;

  constructor(
    private readonly operation: WsDiagnosticOperation,
    connectionId: string | undefined,
    private readonly owner: Owner,
    private readonly subscriptionCount?: number
  ) {
    this.metadata = webSocketDiagnosticMetadata(connectionId);
  }

  async runAttempt<T>(attempt: number, action: () => Promise<T>): Promise<T> {
    this.attempt = attempt;
    this.attemptStarted = performance.now();
    this.phase = 'acquisition';
    this.sessionId = null;
    this.isolation = null;
    return attempts.run(this, action);
  }

  completed(): void {
    this.report(false, {
      outcome:
        this.owner === 'repository' ? 'committed' : 'statements_completed',
      recovered: this.attempt > 1,
      retry_pending: false
    });
  }

  failed(error: unknown, retryPending: boolean): void {
    const detail = errorMetadata(error);
    this.report(true, {
      ...detail,
      outcome: retryPending ? 'retry_pending' : 'failed',
      transaction_outcome:
        this.owner === 'repository' && detail.mysql_code === 'ER_LOCK_DEADLOCK'
          ? 'rolled_back_by_mysql'
          : 'unknown',
      retry_pending: retryPending,
      retries_exhausted:
        this.owner === 'repository' &&
        detail.mysql_code === 'ER_LOCK_DEADLOCK' &&
        this.attempt >= 3
    });
  }

  private report(failed: boolean, detail: Record<string, unknown>): void {
    logWebSocketDiagnostic(failed, {
      ...this.metadata,
      event: 'ws_transaction',
      mutation_id: this.mutationId,
      operation: this.operation,
      transaction_owner: this.owner,
      phase: this.phase,
      attempt: this.attempt,
      max_attempts: this.owner === 'repository' ? 3 : 1,
      db_session_id: this.sessionId,
      isolation: this.isolation,
      subscription_count: this.subscriptionCount ?? null,
      attempt_ms: Math.round(performance.now() - this.attemptStarted),
      total_ms: Math.round(performance.now() - this.started),
      ...detail
    });
  }
}
