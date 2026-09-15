import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import * as mysql from 'mysql';
import { Logger } from '@/logging';

export interface SqlExecutionBudget {
  readonly deadlineMonotonicMillis: number;
  readonly maxStatementMillis: number;
  readonly finalizationReserveMillis: number;
  readonly lockWaitSeconds: number;
}

export interface SqlStatementLimits {
  readonly deadlineMonotonicMillis: number;
  readonly maxStatementMillis: number;
}

export type SqlBudgetPhase =
  | 'ACQUIRE'
  | 'SETUP'
  | 'WORK'
  | 'COMMIT'
  | 'ROLLBACK'
  | 'RESTORE'
  | 'RELEASE';
export type SqlCommitOutcome = 'NOT_SENT' | 'UNKNOWN' | 'ACKNOWLEDGED';
export type SqlBudgetCode =
  | 'SQL_BUDGET_EXCEEDED'
  | 'SQL_CONCURRENT_STATEMENTS'
  | 'SQL_SCOPE_CLOSED'
  | 'SQL_STATEMENT_FAILED';

export class SqlExecutionBudgetExceededError extends Error {
  connectionDestroyed = false;
  constructor(
    readonly code: SqlBudgetCode,
    readonly phase: SqlBudgetPhase,
    readonly commitOutcome: SqlCommitOutcome,
    readonly serverCode?: string
  ) {
    super(`${code} during ${phase} (commit ${commitOutcome})`);
    this.name = 'SqlExecutionBudgetExceededError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

declare const budgetTokenBrand: unique symbol;
export interface SqlExecutionBudgetToken {
  readonly [budgetTokenBrand]: true;
}
export interface SqlBudgetQueryOptions {
  readonly executionBudgetToken?: SqlExecutionBudgetToken;
  readonly statementLimits?: SqlStatementLimits;
}

export interface SqlBudgetConnection {
  readonly handle: object;
  readonly physical: mysql.PoolConnection;
  // Completion transfers ownership back to the pool; adapters must not defer it
  // after returning the physical connection to another borrower.
  readonly release: () => void | Promise<void>;
}

const scopes = new WeakMap<object, SqlBudgetScope>();
const tokens = new WeakMap<SqlExecutionBudgetToken, SqlBudgetScope>();

function integer(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid SQL execution budget ${name}`);
  }
}

export function validateSqlExecutionBudget(
  input: SqlExecutionBudget
): Readonly<SqlExecutionBudget> {
  integer(input.maxStatementMillis, 'statement limit', 60_000);
  integer(input.finalizationReserveMillis, 'finalization reserve', 120_000);
  integer(input.lockWaitSeconds, 'lock wait', 60);
  if (
    !Number.isFinite(input.deadlineMonotonicMillis) ||
    input.deadlineMonotonicMillis - input.finalizationReserveMillis <=
      performance.now() ||
    input.deadlineMonotonicMillis - performance.now() > 2_147_483_647
  ) {
    throw new Error('Invalid SQL execution budget deadline');
  }
  return Object.freeze({
    deadlineMonotonicMillis: input.deadlineMonotonicMillis,
    maxStatementMillis: input.maxStatementMillis,
    finalizationReserveMillis: input.finalizationReserveMillis,
    lockWaitSeconds: input.lockWaitSeconds
  });
}

/** SESSION variables can arrive as strings even through the real loop driver. */
export function normalizeSqlSessionInteger(value: unknown): number {
  if (
    (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) ||
    !['string', 'number', 'bigint'].includes(typeof value)
  ) {
    throw new Error('Invalid saved SQL session value');
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('Invalid saved SQL session value');
  }
  return normalized;
}

function sanitizedDriverError(
  error: unknown,
  scope: SqlBudgetScope
): SqlExecutionBudgetExceededError {
  const rawCode =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  const code =
    typeof rawCode === 'string' && /^(ER_|PROTOCOL_)[A-Z0-9_]+$/.test(rawCode)
      ? rawCode
      : undefined;
  return new SqlExecutionBudgetExceededError(
    'SQL_STATEMENT_FAILED',
    scope.phase,
    scope.commitOutcome,
    code
  );
}

class SqlBudgetScope {
  readonly token = Object.freeze({}) as SqlExecutionBudgetToken;
  readonly workDeadlineMonotonicMillis: number;
  readonly description: Readonly<
    SqlExecutionBudget & { workDeadlineMonotonicMillis: number }
  >;
  readonly limits = new AsyncLocalStorage<SqlStatementLimits | undefined>();
  phase: SqlBudgetPhase = 'SETUP';
  commitOutcome: SqlCommitOutcome = 'NOT_SENT';
  destroyed = false;
  closed = false;
  pending = false;
  failure?: { error: unknown };
  private readonly abortListeners = new Set<(error: unknown) => void>();
  private readonly overallTimer: ReturnType<typeof setTimeout>;

  constructor(
    readonly budget: Readonly<SqlExecutionBudget>,
    readonly connection: SqlBudgetConnection
  ) {
    this.workDeadlineMonotonicMillis =
      budget.deadlineMonotonicMillis - budget.finalizationReserveMillis;
    this.description = Object.freeze({
      ...budget,
      workDeadlineMonotonicMillis: this.workDeadlineMonotonicMillis
    });
    this.overallTimer = setTimeout(
      () => this.abort(this.exceeded()),
      Math.max(0, budget.deadlineMonotonicMillis - performance.now())
    );
    scopes.set(connection.handle, this);
    scopes.set(connection.physical, this);
    tokens.set(this.token, this);
  }

  exceeded(): SqlExecutionBudgetExceededError {
    return new SqlExecutionBudgetExceededError(
      'SQL_BUDGET_EXCEEDED',
      this.phase,
      this.commitOutcome
    );
  }

  fail(error: unknown): void {
    this.failure ??= { error };
  }

  abort(error: unknown): void {
    this.fail(error);
    if (!this.destroyed) {
      this.destroyed = true;
      try {
        this.connection.physical.destroy();
      } catch {
        /* Still revoke and settle every waiter. */
      }
    }
    if (error instanceof SqlExecutionBudgetExceededError)
      error.connectionDestroyed = true;
    if (this.failure?.error instanceof SqlExecutionBudgetExceededError)
      this.failure.error.connectionDestroyed = true;
    for (const reject of Array.from(this.abortListeners))
      reject(this.failure!.error);
  }

  assertWorkRemaining(minimumMillis = 0): void {
    if (!Number.isFinite(minimumMillis) || minimumMillis < 0)
      throw new Error('Invalid minimum SQL work budget');
    if (this.closed)
      throw new SqlExecutionBudgetExceededError(
        'SQL_SCOPE_CLOSED',
        'WORK',
        this.commitOutcome
      );
    if (this.failure) throw this.failure.error;
    if (
      this.destroyed ||
      this.workDeadlineMonotonicMillis - performance.now() <= minimumMillis
    ) {
      const error = this.exceeded();
      this.abort(error);
      throw error;
    }
  }

  validateLimits(limits?: SqlStatementLimits): void {
    if (!limits) return;
    integer(
      limits.maxStatementMillis,
      'narrowed statement limit',
      this.budget.maxStatementMillis
    );
    if (
      !Number.isFinite(limits.deadlineMonotonicMillis) ||
      limits.deadlineMonotonicMillis > this.workDeadlineMonotonicMillis
    ) {
      throw new Error('Statement limits cannot extend the SQL work deadline');
    }
  }

  async work<T>(executable: () => Promise<T>): Promise<T> {
    this.phase = 'WORK';
    this.assertWorkRemaining();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: { value: unknown } | null, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortListeners.delete(onAbort);
        if (error) reject(error.value);
        else resolve(result as T);
      };
      const onAbort = (error: unknown) => finish({ value: error });
      const timer = setTimeout(
        () => this.abort(this.exceeded()),
        Math.max(0, this.workDeadlineMonotonicMillis - performance.now())
      );
      this.abortListeners.add(onAbort);
      Promise.resolve()
        .then(executable)
        .then(
          (value) => finish(null, value),
          (error: unknown) => {
            this.fail(error);
            finish({ value: this.failure!.error });
          }
        );
    });
  }

  /** Own settlement independently of the driver, which can suppress callbacks on destroy. */
  statement<T>(send: () => Promise<T>): Promise<T> {
    if (this.closed || this.destroyed)
      return Promise.reject(
        this.failure?.error ??
          new SqlExecutionBudgetExceededError(
            'SQL_SCOPE_CLOSED',
            this.phase,
            this.commitOutcome
          )
      );
    if (this.pending) {
      const error = new SqlExecutionBudgetExceededError(
        'SQL_CONCURRENT_STATEMENTS',
        this.phase,
        this.commitOutcome
      );
      this.abort(error);
      return Promise.reject(error);
    }
    const workPhase = this.phase === 'WORK' || this.phase === 'SETUP';
    const limits = this.phase === 'WORK' ? this.limits.getStore() : undefined;
    this.validateLimits(limits);
    const phaseDeadline = workPhase
      ? this.workDeadlineMonotonicMillis
      : this.budget.deadlineMonotonicMillis;
    const deadline = Math.min(
      phaseDeadline,
      limits?.deadlineMonotonicMillis ?? Infinity,
      performance.now() +
        (limits?.maxStatementMillis ?? this.budget.maxStatementMillis)
    );
    if (deadline <= performance.now() || (workPhase && this.failure)) {
      const error = this.failure?.error ?? this.exceeded();
      this.abort(error);
      return Promise.reject(error);
    }
    this.pending = true;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: { value: unknown } | null, value?: T) => {
        if (settled) return;
        settled = true;
        this.pending = false;
        clearTimeout(timer);
        this.abortListeners.delete(onAbort);
        if (error) reject(error.value);
        else resolve(value as T);
      };
      const onAbort = (error: unknown) => finish({ value: error });
      const timer = setTimeout(
        () => this.abort(this.exceeded()),
        Math.max(0, deadline - performance.now())
      );
      this.abortListeners.add(onAbort);
      // COMMIT is conservatively sent only after the live pre-send check passes.
      if (this.phase === 'COMMIT') this.commitOutcome = 'UNKNOWN';
      let operation: Promise<T>;
      try {
        operation = send();
      } catch (error) {
        operation = Promise.reject(error);
      }
      operation.then(
        (value) => {
          if (settled) return;
          if (performance.now() >= deadline) {
            this.abort(this.exceeded());
            return;
          }
          if (this.phase === 'COMMIT') this.commitOutcome = 'ACKNOWLEDGED';
          finish(null, value);
        },
        (original: unknown) => {
          if (settled) return;
          const error = sanitizedDriverError(original, this);
          this.fail(error);
          const fatal =
            original &&
            typeof original === 'object' &&
            'fatal' in original &&
            original.fatal;
          if (
            fatal ||
            this.phase === 'COMMIT' ||
            /TIMEOUT|INTERRUPTED/.test(error.serverCode ?? '')
          )
            this.abort(error);
          finish({ value: error });
        }
      );
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.overallTimer);
    this.abortListeners.clear();
    this.limits.disable();
    scopes.delete(this.connection.handle);
    scopes.delete(this.connection.physical);
    // Token -> closed scope is retained weakly, so cached options fail after pool reuse.
  }
}

function scopeFor(
  handle: object,
  token?: SqlExecutionBudgetToken
): SqlBudgetScope {
  const scope = token ? tokens.get(token) : scopes.get(handle);
  if (!scope || scope.closed || scopes.get(handle) !== scope) {
    throw new SqlExecutionBudgetExceededError(
      'SQL_SCOPE_CLOSED',
      'WORK',
      scope?.commitOutcome ?? 'NOT_SENT'
    );
  }
  return scope;
}

export function sqlExecutionBudgetFor(handle: object) {
  const scope = scopeFor(handle);
  scope.assertWorkRemaining();
  return scope.description;
}

export function sqlExecutionBudgetTokenFor(
  handle: object
): SqlExecutionBudgetToken {
  const scope = scopeFor(handle);
  scope.assertWorkRemaining();
  return scope.token;
}

export function assertSqlWorkBudget(
  handle: object,
  minimumRemainingMillis = 0
): void {
  scopeFor(handle).assertWorkRemaining(minimumRemainingMillis);
}

export function withSqlBudgetQueryOptions<T>(
  handle: object,
  options: SqlBudgetQueryOptions | undefined,
  query: () => Promise<T>
): Promise<T> {
  if (
    !options?.executionBudgetToken &&
    !options?.statementLimits &&
    !scopes.has(handle)
  )
    return query();
  const scope = scopeFor(handle, options?.executionBudgetToken);
  try {
    scope.assertWorkRemaining();
    scope.validateLimits(options?.statementLimits);
  } catch (error) {
    scope.fail(error);
    throw error;
  }
  return scope.limits.run(
    options?.statementLimits
      ? Object.freeze({ ...options.statementLimits })
      : undefined,
    query
  );
}

function installQueryInterceptor(scope: SqlBudgetScope): () => void {
  const connection = scope.connection.physical;
  const original = connection.query;
  const originalFormat = connection.config.queryFormat;
  const intercepted = (...args: unknown[]): mysql.Query => {
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') {
      const error = new Error('Budgeted SQL requires an observed callback');
      scope.abort(error);
      throw error;
    }
    let nativeQuery: mysql.Query | undefined;
    scope
      .statement(
        () =>
          new Promise<{ result: unknown; fields: unknown }>(
            (resolve, reject) => {
              const actual = [...args];
              const first = actual[0];
              const timeout = Math.max(
                1,
                Math.ceil(
                  Math.min(
                    scope.budget.maxStatementMillis,
                    scope.budget.deadlineMonotonicMillis - performance.now()
                  )
                )
              );
              actual[0] =
                typeof first === 'string'
                  ? { sql: first, timeout }
                  : { ...(first as object), timeout };
              actual[actual.length - 1] = (
                error: unknown,
                result: unknown,
                fields: unknown
              ) => (error ? reject(error) : resolve({ result, fields }));
              nativeQuery = Reflect.apply(
                original,
                connection,
                actual
              ) as mysql.Query;
            }
          )
      )
      .then(
        ({ result, fields }) => callback(null, result, fields),
        (error: unknown) => callback(error)
      )
      .catch((error: unknown) => scope.abort(error));
    return nativeQuery as mysql.Query;
  };
  connection.query = intercepted as mysql.PoolConnection['query'];
  return () => {
    connection.query = original;
    connection.config.queryFormat = originalFormat;
  };
}

function nativeQuery(
  connection: mysql.PoolConnection,
  sql: string,
  values: readonly number[] = []
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    // Format numeric parameters independently of a caller's named queryFormat.
    connection.query(mysql.format(sql, [...values]), (error, rows) =>
      error ? reject(error) : resolve(rows)
    );
  });
}

/** Bound lease finalization separately after removing the live SQL interceptor. */
async function releaseBudgetedLease(
  lease: SqlBudgetConnection,
  deadline: number,
  onFailure: (error: unknown) => void
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: { value: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) onFailure(error.value);
      resolve();
    };
    const timer = setTimeout(
      () => finish({ value: new Error('SQL lease release deadline exceeded') }),
      Math.max(0, deadline - performance.now())
    );
    Promise.resolve()
      .then(() => lease.release())
      .then(
        () => finish(),
        (error: unknown) => finish({ value: error })
      );
  });
}

async function acquireBudgeted(
  acquire: () => Promise<SqlBudgetConnection>,
  budget: Readonly<SqlExecutionBudget>
): Promise<SqlBudgetConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(
          new SqlExecutionBudgetExceededError(
            'SQL_BUDGET_EXCEEDED',
            'ACQUIRE',
            'NOT_SENT'
          )
        );
      },
      Math.max(
        0,
        budget.deadlineMonotonicMillis -
          budget.finalizationReserveMillis -
          performance.now()
      )
    );
    Promise.resolve()
      .then(acquire)
      .then(
        async (lease) => {
          if (settled) {
            await releaseBudgetedLease(
              lease,
              budget.deadlineMonotonicMillis,
              () => {
                try {
                  lease.physical.destroy();
                } catch {
                  /* Late unused acquisition remains revoked. */
                }
              }
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(lease);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      )
      .catch(() => {
        /* Observe late acquisition cleanup failure; no SQL was started. */
      });
  });
}

/** Opt-in lifecycle shared by native API/test pools and the actual TypeORM loop. */
export async function executeBudgetedSqlTransaction<T>(
  acquire: () => Promise<SqlBudgetConnection>,
  input: SqlExecutionBudget,
  executable: (handle: object) => Promise<T>
): Promise<T> {
  const budget = validateSqlExecutionBudget(input);
  const lease = await acquireBudgeted(acquire, budget);
  if (typeof lease.physical.destroy !== 'function') {
    await lease.release();
    throw new Error('SQL budget requires physical connection disposal');
  }
  const scope = new SqlBudgetScope(budget, lease);
  const restoreQuery = installQueryInterceptor(scope);
  let saved: { execution: number; lock: number } | undefined;
  let began = false;
  let result: T;
  const query = (
    phase: SqlBudgetPhase,
    sql: string,
    values?: readonly number[]
  ) => {
    scope.phase = phase;
    return nativeQuery(lease.physical, sql, values);
  };
  try {
    const rows = await query(
      'SETUP',
      'SELECT @@SESSION.max_execution_time AS execution_millis, @@SESSION.innodb_lock_wait_timeout AS lock_seconds'
    );
    const raw = rows[0] as { execution_millis: unknown; lock_seconds: unknown };
    saved = {
      execution: normalizeSqlSessionInteger(raw.execution_millis),
      lock: normalizeSqlSessionInteger(raw.lock_seconds)
    };
    if (!saved.lock) throw new Error('Invalid saved SQL lock wait');
    await query(
      'SETUP',
      'SET SESSION max_execution_time = ?, innodb_lock_wait_timeout = ?',
      [budget.maxStatementMillis, budget.lockWaitSeconds]
    );
    await query('SETUP', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query('SETUP', 'START TRANSACTION');
    began = true;
    result = await scope.work(() => executable(lease.handle));
    scope.assertWorkRemaining();
    if (scope.pending) {
      const error = new SqlExecutionBudgetExceededError(
        'SQL_CONCURRENT_STATEMENTS',
        'WORK',
        'NOT_SENT'
      );
      scope.abort(error);
      throw error;
    }
    await query('COMMIT', 'COMMIT');
  } catch (error) {
    scope.fail(error);
    if (scope.pending || !began) scope.abort(error);
    if (began && !scope.destroyed && scope.commitOutcome === 'NOT_SENT') {
      try {
        await query('ROLLBACK', 'ROLLBACK');
      } catch (rollbackError) {
        scope.abort(rollbackError);
      }
    }
    throw error;
  } finally {
    if (saved && !scope.destroyed) {
      try {
        await query(
          'RESTORE',
          'SET SESSION max_execution_time = ?, innodb_lock_wait_timeout = ?',
          [saved.execution, saved.lock]
        );
      } catch (cleanupError) {
        scope.abort(cleanupError);
        try {
          Logger.get('SQL_EXECUTION_BUDGET').warn({
            event: 'SQL_SESSION_RESTORE_FAILED',
            commitOutcome: scope.commitOutcome,
            connectionDestroyed: scope.destroyed
          });
        } catch {
          /* Observability cannot change an acknowledged commit outcome. */
        }
      }
    }
    // Acknowledged commit remains known committed after restoration failure.
    restoreQuery();
    scope.close();
    scope.phase = 'RELEASE';
    await releaseBudgetedLease(lease, budget.deadlineMonotonicMillis, (error) =>
      scope.abort(error)
    );
  }
  return result!;
}
