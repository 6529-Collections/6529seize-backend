import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { PoolConnection } from 'mysql';
import {
  executeBudgetedSqlTransaction,
  normalizeSqlSessionInteger,
  SqlExecutionBudget,
  sqlExecutionBudgetTokenFor,
  withSqlBudgetQueryOptions
} from './sql-execution-budget';
import { execSQLWithParams } from './my-sql.helpers';
import {
  assertMembershipPrimaryContext,
  membershipQueryOptions,
  MembershipPrimaryContext,
  withMembershipPrimaryTransaction
} from '@/membership/membership-primary';
import { SqlExecutor } from '@/sql-executor';

type Callback = (error: unknown, rows?: unknown) => void;
function budget(work = 100, statement = 60): SqlExecutionBudget {
  return {
    deadlineMonotonicMillis: performance.now() + work + 100,
    maxStatementMillis: statement,
    finalizationReserveMillis: 100,
    lockWaitSeconds: 1
  };
}
function fakeDriver(
  intercept?: (sql: string, callback: Callback) => boolean,
  saved: unknown = '0'
) {
  const statements: string[] = [];
  const queryObject = new EventEmitter();
  const destroy = jest.fn();
  const release = jest.fn();
  const connection = {
    config: {},
    destroy,
    release,
    query: (input: string | { sql: string }, callback: Callback) => {
      const sql = typeof input === 'string' ? input : input.sql;
      statements.push(sql);
      if (!intercept?.(sql, callback))
        queueMicrotask(() =>
          callback(
            null,
            sql.startsWith('SELECT @@SESSION')
              ? [{ execution_millis: saved, lock_seconds: '50' }]
              : [{ value: 1 }]
          )
        );
      return queryObject;
    }
  } as unknown as PoolConnection;
  const lease = { handle: connection, physical: connection, release };
  return { connection, lease, destroy, release, statements, queryObject };
}
function executor(driver: ReturnType<typeof fakeDriver>): SqlExecutor {
  return {
    execute: (sql, params, options) =>
      execSQLWithParams(sql, driver.connection, false, params, options),
    executeNativeQueriesInTransaction: (callback, options) =>
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        options!.executionBudget!,
        (handle) => callback({ connection: handle })
      )
  } as SqlExecutor;
}

describe('physical SQL execution budgets', () => {
  it('restores numeric session values and rejects a cached token after healthy release', async () => {
    const driver = fakeDriver();
    const originalFormat = jest.fn((sql: string) => sql);
    driver.connection.config.queryFormat = originalFormat;
    let token: ReturnType<typeof sqlExecutionBudgetTokenFor> | undefined;
    const value = await executeBudgetedSqlTransaction(
      async () => driver.lease,
      budget(),
      async (handle) => {
        token = sqlExecutionBudgetTokenFor(handle);
        return (
          await execSQLWithParams<{ value: number }>(
            'SELECT value',
            driver.connection,
            false
          )
        )[0].value;
      }
    );
    expect(value).toBe(1);
    expect(driver.statements).toContain(
      'SET SESSION max_execution_time = 0, innodb_lock_wait_timeout = 50'
    );
    expect(driver.statements).toContain('COMMIT');
    expect(driver.destroy).not.toHaveBeenCalled();
    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(driver.connection.config.queryFormat).toBe(originalFormat);
    const late = jest.fn().mockResolvedValue([]);
    expect(() =>
      withSqlBudgetQueryOptions(
        driver.connection,
        { executionBudgetToken: token },
        late
      )
    ).toThrow('SQL_SCOPE_CLOSED');
    expect(late).not.toHaveBeenCalled();
  });

  it('settles a suppressed driver callback, destroys once and revokes a still-pending primary callback', async () => {
    let late: Callback | undefined;
    const driver = fakeDriver((sql, callback) => {
      if (sql === 'SELECT withheld') {
        late = callback;
        return true;
      }
      return false;
    });
    const originalFormat = jest.fn((sql: string) => sql);
    driver.connection.config.queryFormat = originalFormat;
    const db = executor(driver);
    let context: MembershipPrimaryContext | undefined;
    let cached: ReturnType<typeof membershipQueryOptions> | undefined;
    const operation = withMembershipPrimaryTransaction(
      db,
      async (ctx) => {
        context = ctx;
        cached = membershipQueryOptions(ctx);
        try {
          await db.execute('SELECT withheld', undefined, cached);
        } catch {
          /* Intentionally suppress callback failure. */
        }
        return new Promise<never>(() => undefined);
      },
      {},
      budget(200, 30)
    );
    await expect(operation).rejects.toMatchObject({
      code: 'SQL_BUDGET_EXCEEDED',
      phase: 'WORK',
      commitOutcome: 'NOT_SENT',
      connectionDestroyed: true
    });
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.connection.config.queryFormat).toBe(originalFormat);
    expect(() => assertMembershipPrimaryContext(context!)).toThrow(
      'active primary'
    );
    await expect(db.execute('SELECT late', undefined, cached)).rejects.toThrow(
      'SQL_SCOPE_CLOSED'
    );
    late?.(null, [{ value: 2 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.statements).not.toContain('COMMIT');
    expect(driver.statements).not.toContain('SELECT late');
  });

  it('bounds idle application awaits without waiting for callback completion', async () => {
    const driver = fakeDriver();
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(30),
        async () => new Promise<never>(() => undefined)
      )
    ).rejects.toMatchObject({
      commitOutcome: 'NOT_SENT',
      connectionDestroyed: true
    });
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).toHaveBeenCalledTimes(1);
  });

  it('does not extend an absolute statement timer when packets continue arriving', async () => {
    const driver = fakeDriver((sql) => sql === 'SELECT packets');
    const packets = setInterval(() => driver.queryObject.emit('packet'), 3);
    try {
      await expect(
        executeBudgetedSqlTransaction(
          async () => driver.lease,
          budget(200, 30),
          async () =>
            execSQLWithParams('SELECT packets', driver.connection, false)
        )
      ).rejects.toMatchObject({ code: 'SQL_BUDGET_EXCEEDED' });
    } finally {
      clearInterval(packets);
    }
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  it('enforces narrower query limits and rejects limits that extend the scope', async () => {
    const driver = fakeDriver((sql) => sql === 'SELECT wait');
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(200, 100),
        async (handle) => {
          const options = {
            executionBudgetToken: sqlExecutionBudgetTokenFor(handle),
            statementLimits: {
              maxStatementMillis: 20,
              deadlineMonotonicMillis: performance.now() + 100
            }
          };
          return execSQLWithParams(
            'SELECT wait',
            driver.connection,
            false,
            undefined,
            options
          );
        }
      )
    ).rejects.toMatchObject({ code: 'SQL_BUDGET_EXCEEDED', phase: 'WORK' });
    const other = fakeDriver();
    await expect(
      executeBudgetedSqlTransaction(
        async () => other.lease,
        budget(),
        async (handle) =>
          withSqlBudgetQueryOptions(
            handle,
            {
              statementLimits: {
                maxStatementMillis: 1000,
                deadlineMonotonicMillis: performance.now() + 10000
              }
            },
            async () => []
          )
      )
    ).rejects.toThrow('statement limit');
    expect(other.statements).not.toContain('COMMIT');
  });

  it('aborts concurrent statements without queuing rollback behind unresolved SQL', async () => {
    const driver = fakeDriver((sql) => sql === 'SELECT first');
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => {
          return Promise.all([
            execSQLWithParams('SELECT first', driver.connection, false),
            execSQLWithParams('SELECT second', driver.connection, false)
          ]);
        }
      )
    ).rejects.toMatchObject({
      code: 'SQL_CONCURRENT_STATEMENTS',
      connectionDestroyed: true
    });
    expect(driver.statements).not.toContain('SELECT second');
    expect(driver.statements).not.toContain('ROLLBACK');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  it('normalizes the supported MySQL NOWAIT errno without exposing driver detail', async () => {
    const driver = fakeDriver((sql, callback) => {
      if (sql !== 'SELECT contention') return false;
      queueMicrotask(() =>
        callback({
          code: 'UNKNOWN_CODE_PLEASE_REPORT',
          errno: 3572,
          sql: 'private SQL',
          message: 'private detail'
        })
      );
      return true;
    });
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () =>
          execSQLWithParams('SELECT contention', driver.connection, false)
      )
    ).rejects.toMatchObject({
      code: 'SQL_STATEMENT_FAILED',
      serverCode: 'ER_LOCK_NOWAIT',
      phase: 'WORK',
      commitOutcome: 'NOT_SENT',
      connectionDestroyed: false
    });
    expect(driver.statements).toContain('ROLLBACK');
    expect(driver.destroy).not.toHaveBeenCalled();
  });

  it.each([
    'COMMIT',
    '/* ordinary comment */ COMMIT',
    'ROLLBACK',
    'START TRANSACTION',
    'SET autocommit = 1',
    'TRUNCATE TABLE fixture',
    '/*! COMMIT */'
  ])(
    'prevents application outer transaction control %s before the driver send',
    async (sql) => {
      const driver = fakeDriver();
      await expect(
        executeBudgetedSqlTransaction(
          async () => driver.lease,
          budget(),
          async () => {
            await execSQLWithParams(
              'UPDATE fixture SET value=2',
              driver.connection,
              false
            );
            try {
              await execSQLWithParams(sql, driver.connection, false);
            } catch {
              /* Still rollback-only. */
            }
            return 'caught';
          }
        )
      ).rejects.toMatchObject({
        code: 'SQL_TRANSACTION_CONTROL',
        commitOutcome: 'NOT_SENT'
      });
      expect(
        driver.statements.filter((statement) => statement === 'ROLLBACK')
      ).toHaveLength(1);
      if (sql === 'START TRANSACTION')
        expect(
          driver.statements.filter((statement) => statement === sql)
        ).toHaveLength(1);
      else if (sql !== 'ROLLBACK') expect(driver.statements).not.toContain(sql);
      expect(driver.statements).not.toContain('COMMIT');
    }
  );

  it('bounds pool acquisition and releases a late connection unused', async () => {
    const driver = fakeDriver();
    let acquired: (value: typeof driver.lease) => void = () => undefined;
    const acquisition = new Promise<typeof driver.lease>((resolve) => {
      acquired = resolve;
    });
    await expect(
      executeBudgetedSqlTransaction(
        () => acquisition,
        budget(20),
        async () => 'never'
      )
    ).rejects.toMatchObject({ phase: 'ACQUIRE', commitOutcome: 'NOT_SENT' });
    acquired(driver.lease);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.statements).toEqual([]);
    expect(driver.release).toHaveBeenCalledTimes(1);
  });

  it('reports UNKNOWN after withheld COMMIT acknowledgment and ignores a late success', async () => {
    let acknowledge: Callback | undefined;
    const driver = fakeDriver((sql, callback) => {
      if (sql === 'COMMIT') {
        acknowledge = callback;
        return true;
      }
      return false;
    });
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => 'value'
      )
    ).rejects.toMatchObject({
      phase: 'COMMIT',
      commitOutcome: 'UNKNOWN',
      connectionDestroyed: true
    });
    acknowledge?.(null, []);
    expect(driver.statements).not.toContain('ROLLBACK');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves acknowledged business success after restoration callback suppression', async () => {
    const driver = fakeDriver(
      (sql) =>
        sql ===
        'SET SESSION max_execution_time = 0, innodb_lock_wait_timeout = 50'
    );
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => 'committed'
      )
    ).resolves.toBe('committed');
    expect(driver.statements).toContain('COMMIT');
    expect(driver.statements).not.toContain('ROLLBACK');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  it('bounds a suppressed lease-release promise after acknowledged commit', async () => {
    const driver = fakeDriver();
    driver.release.mockImplementation(
      () => new Promise<never>(() => undefined)
    );
    const began = performance.now();
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(30, 20),
        async () => 'committed'
      )
    ).resolves.toBe('committed');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(performance.now() - began).toBeLessThan(500);
  });

  it('keeps the first work error when rollback callbacks are suppressed', async () => {
    const failure = new Error('work failed');
    const driver = fakeDriver((sql) => sql === 'ROLLBACK');
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    '9007199254740993',
    BigInt('9007199254740993'),
    '-1',
    '1.1',
    '00',
    null,
    NaN
  ])('rejects invalid saved value %s before SET', async (saved) => {
    const driver = fakeDriver(undefined, saved);
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => undefined
      )
    ).rejects.toThrow('saved SQL session');
    expect(driver.statements).toHaveLength(1);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves exact valid zero and validates limits before acquiring a pool slot', async () => {
    expect(normalizeSqlSessionInteger('0')).toBe(0);
    const acquire = jest.fn();
    for (const maxStatementMillis of [NaN, Infinity, 0, -1, 60001, 1.1]) {
      await expect(
        executeBudgetedSqlTransaction(
          acquire,
          { ...budget(), maxStatementMillis },
          async () => undefined
        )
      ).rejects.toThrow('statement limit');
    }
    expect(acquire).not.toHaveBeenCalled();
  });
  it('rejects a SETUP lifecycle COMMIT before sending or fabricating an undefined result', async () => {
    const driver = fakeDriver();
    const executable = jest.fn().mockResolvedValue('never');
    const lease = {
      ...driver.lease,
      transaction: {
        begin: async () => {
          await execSQLWithParams('COMMIT', driver.connection, false);
          throw new Error('setup failed after unexpected COMMIT');
        },
        commit: jest.fn(),
        rollback: jest.fn()
      }
    };
    await expect(
      executeBudgetedSqlTransaction(async () => lease, budget(), executable)
    ).rejects.toMatchObject({
      code: 'SQL_TRANSACTION_CONTROL',
      phase: 'SETUP',
      commitOutcome: 'NOT_SENT',
      connectionDestroyed: true
    });
    expect(driver.statements).not.toContain('COMMIT');
    expect(executable).not.toHaveBeenCalled();
    expect(driver.release).toHaveBeenCalledTimes(1);
  });
  it('permits an explicitly completed void callback without using an unassigned result assertion', async () => {
    const driver = fakeDriver();
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => undefined
      )
    ).resolves.toBeUndefined();
    expect(driver.statements).toContain('COMMIT');
  });
  it('allows all three savepoint commands within owned work and still rolls back the outer transaction', async () => {
    const driver = fakeDriver();
    const failure = new Error('outer failure');
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => {
          for (const sql of [
            'SAVEPOINT fixture',
            'ROLLBACK TO SAVEPOINT fixture',
            'RELEASE SAVEPOINT fixture'
          ])
            await execSQLWithParams(sql, driver.connection, false);
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(driver.statements).toEqual(
      expect.arrayContaining([
        'SAVEPOINT fixture',
        'ROLLBACK TO SAVEPOINT fixture',
        'RELEASE SAVEPOINT fixture',
        'ROLLBACK'
      ])
    );
    expect(driver.statements).not.toContain('COMMIT');
  });
  it('sends physical SQL synchronously while observing a driver throw as a rejected statement', async () => {
    const driver = fakeDriver((sql) => {
      if (sql === 'SELECT synchronous_failure')
        throw Object.assign(new Error('private driver detail'), {
          code: 'ER_PARSE_ERROR'
        });
      return false;
    });
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        async () => {
          const failed = new Promise<void>((resolve, reject) => {
            const returned = driver.connection.query(
              'SELECT healthy',
              (error) => (error ? reject(error) : resolve())
            );
            expect(returned).toBe(driver.queryObject);
          });
          await failed;
          await execSQLWithParams(
            'SELECT synchronous_failure',
            driver.connection,
            false
          );
        }
      )
    ).rejects.toMatchObject({
      code: 'SQL_STATEMENT_FAILED',
      serverCode: 'ER_PARSE_ERROR',
      commitOutcome: 'NOT_SENT'
    });
    expect(driver.statements).toContain('ROLLBACK');
  });
  it('rejects a second physical statement during an unknown COMMIT without ever sending it', async () => {
    const driver = fakeDriver((sql) => sql === 'COMMIT');
    let commitAttempt!: () => void;
    const attemptingCommit = new Promise<void>((resolve) => {
      commitAttempt = resolve;
    });
    const lease = {
      ...driver.lease,
      transaction: {
        begin: async () => {
          await execSQLWithParams(
            'START TRANSACTION',
            driver.connection,
            false
          );
        },
        commit: async () => {
          const pending = execSQLWithParams('COMMIT', driver.connection, false);
          commitAttempt();
          await pending;
        },
        rollback: jest.fn()
      }
    };
    const operation = executeBudgetedSqlTransaction(
      async () => lease,
      budget(500, 200),
      async () => 'work'
    );
    const rejected = expect(operation).rejects.toMatchObject({
      code: 'SQL_CONCURRENT_STATEMENTS',
      commitOutcome: 'UNKNOWN',
      connectionDestroyed: true
    });
    await attemptingCommit;
    await expect(
      execSQLWithParams('SELECT overlapping_commit', driver.connection, false)
    ).rejects.toMatchObject({
      code: 'SQL_CONCURRENT_STATEMENTS',
      commitOutcome: 'UNKNOWN'
    });
    await rejected;
    expect(driver.statements).not.toContain('SELECT overlapping_commit');
    expect(driver.statements).not.toContain('ROLLBACK');
  });
  it('disposes and releases an acquired lease if interceptor installation fails', async () => {
    const driver = fakeDriver();
    Object.defineProperty(driver.connection, 'query', { writable: false });
    const work = jest.fn();
    await expect(
      executeBudgetedSqlTransaction(async () => driver.lease, budget(), work)
    ).rejects.toBeInstanceOf(TypeError);
    expect(work).not.toHaveBeenCalled();
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(driver.statements).toEqual([]);
    expect(() => sqlExecutionBudgetTokenFor(driver.connection)).toThrow(
      'SQL_SCOPE_CLOSED'
    );
  });
  it('releases an acquired connection rejected for missing physical disposal capability', async () => {
    const driver = fakeDriver();
    Reflect.deleteProperty(driver.connection, 'destroy');
    await expect(
      executeBudgetedSqlTransaction(
        async () => driver.lease,
        budget(),
        jest.fn()
      )
    ).rejects.toThrow('physical connection disposal');
    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(driver.statements).toEqual([]);
  });
});
