import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Logger } from '@/logging';
import { loggerContext, RequestSqlTotals } from '@/logger-context';
import { DbPoolName } from '@/db-query.options';

const SLOW_OPERATION_MS = 1000;
const logger = Logger.get('MYSQL_HELPERS');

export function emptyRequestSqlTotals(): RequestSqlTotals {
  return { operations: 0, acquisitionMs: 0, maxAcquisitionMs: 0, sqlMs: 0 };
}

/** Request-log fields, parseable like `[TOOK_MS n]`. */
export function formatRequestSqlTotals(totals: RequestSqlTotals): string {
  return [
    `[SQL_OPS ${totals.operations}]`,
    `[SQL_ACQUIRE_MS ${Math.round(totals.acquisitionMs)}]`,
    `[SQL_ACQUIRE_MAX_MS ${Math.round(totals.maxAcquisitionMs)}]`,
    `[SQL_MS ${Math.round(totals.sqlMs)}]`
  ].join(' ');
}

/** One pending snapshot and one terminal diagnostic at most per operation. */
export class SqlOperationTiming {
  private readonly started = performance.now();
  private readonly context = { ...loggerContext.get() };
  private readonly pendingTimer: NodeJS.Timeout;
  private operationId?: string;
  private acquisitionMs: number | null = null;
  private sqlStarted?: number;
  private sqlFinished?: number;
  private stage: 'acquisition' | 'sql_setup' | 'sql' | 'result';
  private pendingLogged = false;

  constructor(
    readonly pool: DbPoolName | 'supplied',
    private readonly describeQuery: () => string
  ) {
    this.stage = pool === 'supplied' ? 'sql_setup' : 'acquisition';
    this.pendingTimer = setTimeout(() => {
      this.pendingLogged = true;
      this.log('pending');
    }, SLOW_OPERATION_MS);
    this.pendingTimer.unref();
  }

  acquired() {
    this.acquisitionMs = performance.now() - this.started;
    this.stage = 'sql_setup';
  }

  queryStarted() {
    this.sqlStarted = performance.now();
    this.stage = 'sql';
  }

  queryFinished(failed: boolean) {
    this.sqlFinished = performance.now();
    if (!failed) this.stage = 'result';
  }

  finish(outcome: 'completed' | 'failed') {
    clearTimeout(this.pendingTimer);
    this.addToRequestTotals();
    if (
      outcome === 'failed' ||
      this.pendingLogged ||
      performance.now() - this.started > SLOW_OPERATION_MS
    ) {
      this.log(outcome);
    }
  }

  private addToRequestTotals() {
    // Totals belong to the request the operation started in: the context copy
    // shares that request's totals object, which is never reassigned. Outside
    // a request (loops, startup) there are none and this is a no-op.
    const totals = this.context.sql;
    if (!totals) return;
    const now = performance.now();
    const acquisitionMs =
      this.stage === 'acquisition'
        ? now - this.started
        : (this.acquisitionMs ?? 0);
    totals.operations += 1;
    totals.acquisitionMs += acquisitionMs;
    totals.maxAcquisitionMs = Math.max(totals.maxAcquisitionMs, acquisitionMs);
    if (this.sqlStarted !== undefined) {
      totals.sqlMs += (this.sqlFinished ?? now) - this.sqlStarted;
    }
  }

  private log(outcome: 'pending' | 'completed' | 'failed') {
    const now = performance.now();
    const sqlMs =
      this.sqlStarted === undefined
        ? null
        : Math.round((this.sqlFinished ?? now) - this.sqlStarted);
    const acquisitionMs =
      this.stage === 'acquisition' ? now - this.started : this.acquisitionMs;
    this.operationId ??= randomUUID();
    const details = {
      event: 'sql_operation',
      operation_id: this.operationId,
      outcome,
      stage: this.stage,
      pool: this.pool,
      acquisition_ms: acquisitionMs === null ? null : Math.round(acquisitionMs),
      sql_ms: sqlMs,
      total_ms: Math.round(now - this.started)
    };
    // Diagnostic formatting must never fail a query or throw from the timer.
    let description: string;
    try {
      description = this.describeQuery();
    } catch {
      description = '[query description unavailable]';
    }
    let message: string;
    if (outcome === 'pending') {
      message = `SQL operation still pending: ${description}`;
    } else if (this.stage === 'acquisition') {
      message = `SQL connection acquisition failed: ${description}`;
    } else if (sqlMs === null) {
      message = `SQL operation failed before query execution: ${description}`;
    } else if (
      outcome === 'failed' &&
      now - this.started <= SLOW_OPERATION_MS
    ) {
      message = `SQL operation failed: ${description}`;
    } else {
      // Keep the existing slow-SQL prefix and SQL-only execution measurement.
      message = `SQL query took ${sqlMs} ms to execute: ${description}`;
    }
    try {
      loggerContext.run(this.context, () => logger.warn(message, details));
    } catch {
      // Observability must not fail a query, mask its error, or crash a timer.
    }
  }
}
