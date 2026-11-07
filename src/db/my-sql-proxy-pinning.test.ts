import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { PoolConnection } from 'mysql';
import { DbPoolName } from '@/db-query.options';
import { SqlExecutionBudgetExceededError } from './sql-execution-budget';
import {
  execBudgetedNativeTransactionally,
  execNativeTransactionally,
  execSQLWithConnection,
  execSQLWithParams
} from './my-sql.helpers';
import {
  isProxySessionPinned,
  withProxyPinScope
} from './proxy-session-pinning';

type Callback = (error: unknown, rows?: unknown) => void;
type QueryInput = string | { sql: string; values?: Record<string, unknown> };

/**
 * Emulates mysql: query() formats synchronously through config.queryFormat,
 * and callbacks run in the async context of the socket, i.e. of whichever
 * request opened the connection, not of the request that issued the query.
 */
function fakeConnection(
  respond: (sql: string) => { error?: unknown; rows?: unknown } = () => ({})
) {
  const socket = new AsyncResource('FakeMysqlSocket');
  const statements: string[] = [];
  const release = jest.fn();
  const destroy = jest.fn();
  const connection = {
    config: {} as { queryFormat?: (sql: string, values: unknown) => string },
    release,
    destroy,
    query(input: QueryInput, ...rest: unknown[]) {
      const callback = rest.at(-1) as Callback;
      const sql = typeof input === 'string' ? input : input.sql;
      const values = typeof input === 'string' ? undefined : input.values;
      const formatted = connection.config.queryFormat
        ? connection.config.queryFormat(sql, values)
        : sql;
      statements.push(formatted);
      const { error, rows } = respond(formatted);
      setImmediate(() =>
        socket.runInAsyncScope(() =>
          callback(error ?? null, rows ?? [{ ok: 1 }])
        )
      );
      return { sql: formatted };
    },
    beginTransaction(callback?: (error?: Error) => void) {
      statements.push('BEGIN');
      callback?.();
    },
    commit(callback: (error?: Error) => void) {
      statements.push('COMMIT');
      callback();
    },
    rollback(callback?: () => void) {
      statements.push('ROLLBACK');
      callback?.();
    }
  };
  return {
    connection: connection as unknown as PoolConnection,
    statements,
    release,
    destroy
  };
}

/** About 20 KB once inlined: 500 escaped UUIDs. */
const manyIds = Array.from(
  { length: 500 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const oversized = 'select id from waves where id in (:ids)';

function captureEmf() {
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
  const write = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  return () =>
    write.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('ProxyPinnedSessionRetired'))
      .map((line) => JSON.parse(line));
}

describe('RDS Proxy pin containment outside a request scope', () => {
  const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  afterEach(() => {
    jest.restoreAllMocks();
    if (lambdaName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = lambdaName;
  });

  it('releases a pooled connection after an ordinary statement', async () => {
    const driver = fakeConnection();
    await execSQLWithParams(
      'select 1 from waves where id = :id',
      driver.connection,
      true,
      {
        id: manyIds[0]
      }
    );
    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(driver.destroy).not.toHaveBeenCalled();
  });

  it('destroys a pooled connection after an oversized formatted statement', async () => {
    const records = captureEmf();
    const driver = fakeConnection();
    await execSQLWithConnection(
      oversized,
      { pool: DbPoolName.READ, acquire: async () => driver.connection },
      { ids: manyIds }
    );
    expect(driver.statements[0].length).toBeGreaterThan(16_000);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
    expect(isProxySessionPinned(driver.connection)).toBe(false);
    const [record] = records();
    expect(record).toMatchObject({
      Pool: 'READ',
      Reason: 'oversized_statement',
      ProxyPinStatementBytes: Buffer.byteLength(driver.statements[0]),
      fingerprint: oversized
    });
    expect(JSON.stringify(record)).not.toContain(manyIds[0]);
  });

  it('measures statements without bound values too', async () => {
    const driver = fakeConnection();
    const inlined = `select 1 from t where id in (${manyIds
      .map((id) => `'${id}'`)
      .join(', ')})`;
    await execSQLWithParams(inlined, driver.connection, true);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('never releases a pooled connection whose destroy throws', async () => {
    const driver = fakeConnection();
    driver.destroy.mockImplementation(() => {
      throw new Error('no socket');
    });
    await execSQLWithParams(oversized, driver.connection, true, {
      ids: manyIds
    });
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('still retires a pooled connection when the oversized statement fails', async () => {
    const driver = fakeConnection(() => ({
      error: Object.assign(new Error('parse'), { code: 'ER_PARSE_ERROR' })
    }));
    await expect(
      execSQLWithParams(oversized, driver.connection, true, { ids: manyIds })
    ).rejects.toThrow('parse');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('labels private statement families with a value-free shape hash', async () => {
    const records = captureEmf();
    const run = async (sql: string, ids: string[]) => {
      const driver = fakeConnection();
      await execSQLWithParams(sql, driver.connection, true, { ids });
    };
    const shape = 'select * from e2ee_devices where id in (:ids)';
    await run(shape, manyIds);
    await run(
      shape,
      manyIds.map((id) => id.replace(/^0/, 'f'))
    );
    await run('select id from e2ee_devices where id in (:ids)', manyIds);
    const [first, sameShape, otherShape] = records().map(
      (record) => record.fingerprint as string
    );
    expect(first).toMatch(/^\[private e2ee messaging query #[0-9a-f]{8}\]$/);
    // Bound values never change the hash; a different template does.
    expect(sameShape).toBe(first);
    expect(otherShape).not.toBe(first);
    expect(JSON.stringify(records())).not.toContain('e2ee_devices');
  });

  it('defers a transaction connection to transaction release', async () => {
    const records = captureEmf();
    const driver = fakeConnection();
    const result = await execNativeTransactionally(async ({ connection }) => {
      await execSQLWithParams(oversized, connection, false, { ids: manyIds });
      // The transaction still owns the session: no release or destroy yet.
      expect(driver.destroy).not.toHaveBeenCalled();
      expect(driver.release).not.toHaveBeenCalled();
      await execSQLWithParams('select 1', connection, false);
      return 'done';
    }, driver.connection);
    expect(result).toBe('done');
    expect(driver.statements.at(-1)).toBe('COMMIT');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
    expect(records()[0]).toMatchObject({
      Pool: 'TRANSACTION',
      Reason: 'oversized_statement'
    });
  });

  it('retires an oversized transaction connection after rollback too', async () => {
    const driver = fakeConnection();
    const failure = new Error('work failed');
    await expect(
      execNativeTransactionally(async ({ connection }) => {
        await execSQLWithParams(oversized, connection, false, { ids: manyIds });
        throw failure;
      }, driver.connection)
    ).rejects.toBe(failure);
    expect(driver.statements).toContain('ROLLBACK');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('releases an ordinary transaction connection', async () => {
    const driver = fakeConnection();
    await execNativeTransactionally(async ({ connection }) => {
      await execSQLWithParams('select 1', connection, false);
    }, driver.connection);
    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(driver.destroy).not.toHaveBeenCalled();
  });
});

describe('budgeted API transactions', () => {
  const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  afterEach(() => {
    jest.restoreAllMocks();
    if (lambdaName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = lambdaName;
  });

  function budget() {
    return {
      deadlineMonotonicMillis: performance.now() + 2_000,
      maxStatementMillis: 500,
      finalizationReserveMillis: 500,
      lockWaitSeconds: 1
    };
  }
  const sessionRows = (sql: string) =>
    sql.startsWith('SELECT @@SESSION')
      ? { rows: [{ execution_millis: '0', lock_seconds: '50' }] }
      : {};

  it('retires the session after COMMIT instead of restoring its variables', async () => {
    const records = captureEmf();
    const driver = fakeConnection(sessionRows);
    const result = await execBudgetedNativeTransactionally(
      async ({ connection }) => {
        await execSQLWithParams('update t set v = 1', connection, false);
        return 'committed';
      },
      async () => driver.connection,
      budget()
    );
    expect(result).toBe('committed');
    const commit = driver.statements.indexOf('COMMIT');
    expect(commit).toBeGreaterThan(0);
    expect(
      driver.statements
        .slice(commit)
        .some((sql) => sql.startsWith('SET SESSION'))
    ).toBe(false);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    // The adapter still hands the lease back; mysql ignores release after destroy.
    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(records()).toEqual([
      expect.objectContaining({
        Pool: 'TRANSACTION',
        Reason: 'session_settings'
      })
    ]);
  });

  it('neither restores nor releases a session whose destroy throws', async () => {
    const driver = fakeConnection(sessionRows);
    driver.destroy.mockImplementation(() => {
      throw new Error('no socket');
    });
    await expect(
      execBudgetedNativeTransactionally(
        async () => 'committed',
        async () => driver.connection,
        budget()
      )
    ).resolves.toBe('committed');
    const commit = driver.statements.indexOf('COMMIT');
    expect(
      driver.statements.slice(commit).some((sql) => sql.startsWith('SET'))
    ).toBe(false);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('keeps deadlock retry eligibility after an acknowledged ROLLBACK', async () => {
    const driver = fakeConnection((sql) =>
      sql === 'update t set v = 1'
        ? {
            error: Object.assign(new Error('deadlock'), {
              code: 'ER_LOCK_DEADLOCK'
            })
          }
        : sessionRows(sql)
    );
    const error = await execBudgetedNativeTransactionally(
      async ({ connection }) => {
        await execSQLWithParams('update t set v = 1', connection, false);
      },
      async () => driver.connection,
      budget()
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(SqlExecutionBudgetExceededError);
    expect(error).toMatchObject({
      serverCode: 'ER_LOCK_DEADLOCK',
      phase: 'WORK',
      commitOutcome: 'NOT_SENT',
      connectionDestroyed: false
    });
    expect(driver.statements).toContain('ROLLBACK');
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });
});

/** mysql 2.x pool shape around fake connections: idle ones wait in `_freeConnections`. */
function fakePool() {
  const pool = { _freeConnections: [] as PoolConnection[] };
  const created: ReturnType<typeof fakeConnection>[] = [];
  const acquire = async (): Promise<PoolConnection> => {
    const idle = pool._freeConnections.shift();
    if (idle) return idle;
    const driver = fakeConnection();
    const connection = driver.connection as unknown as { _pool: unknown };
    connection._pool = pool;
    driver.release.mockImplementation(() => {
      pool._freeConnections.push(driver.connection);
    });
    driver.destroy.mockImplementation(() => {
      const index = pool._freeConnections.indexOf(driver.connection);
      if (index !== -1) pool._freeConnections.splice(index, 1);
      connection._pool = null;
    });
    created.push(driver);
    return driver.connection;
  };
  return { acquire, created };
}

describe('RDS Proxy pin containment inside a request scope', () => {
  it('runs every oversized statement of a request on one reused connection', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      for (let i = 0; i < 6; i++) {
        await execSQLWithConnection(
          oversized,
          { pool: DbPoolName.READ, acquire: pool.acquire },
          { ids: manyIds }
        );
      }
      expect(pool.created).toHaveLength(1);
      expect(pool.created[0].release).toHaveBeenCalledTimes(6);
      expect(pool.created[0].destroy).not.toHaveBeenCalled();
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a connection opened by an earlier request reusable until this request ends', async () => {
    const pool = fakePool();
    // An earlier invocation opens the connection, so its socket callbacks run
    // in that (now closed) invocation's context.
    await withProxyPinScope(async () => {
      await execSQLWithConnection(
        'select 1',
        { pool: DbPoolName.READ, acquire: pool.acquire },
        {}
      );
    });
    await withProxyPinScope(async () => {
      for (let i = 0; i < 3; i++) {
        await execSQLWithConnection(
          oversized,
          { pool: DbPoolName.READ, acquire: pool.acquire },
          { ids: manyIds }
        );
      }
      expect(pool.created).toHaveLength(1);
      expect(pool.created[0].destroy).not.toHaveBeenCalled();
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('retires each connection pinned by concurrent statements once', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      await Promise.all(
        [1, 2, 3].map(() =>
          execSQLWithConnection(
            oversized,
            { pool: DbPoolName.READ, acquire: pool.acquire },
            { ids: manyIds }
          )
        )
      );
    });
    expect(pool.created).toHaveLength(3);
    for (const driver of pool.created) {
      expect(driver.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it('retires pinned connections when the request fails', async () => {
    const pool = fakePool();
    const failure = new Error('handler failed');
    await expect(
      withProxyPinScope(async () => {
        await execSQLWithConnection(
          oversized,
          { pool: DbPoolName.READ, acquire: pool.acquire },
          { ids: manyIds }
        );
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('returns a pinned transaction connection to the pool until request end', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      await execNativeTransactionally(
        async ({ connection }) => {
          await execSQLWithParams(oversized, connection, false, {
            ids: manyIds
          });
        },
        await pool.acquire()
      );
      expect(pool.created[0].release).toHaveBeenCalledTimes(1);
      expect(pool.created[0].destroy).not.toHaveBeenCalled();
      // A later statement in the same request reuses it.
      await execSQLWithConnection(
        'select 1',
        { pool: DbPoolName.WRITE, acquire: pool.acquire },
        {}
      );
      expect(pool.created).toHaveLength(1);
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary connections pooled across the request end', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      await execSQLWithConnection(
        'select 1',
        { pool: DbPoolName.READ, acquire: pool.acquire },
        {}
      );
    });
    expect(pool.created[0].destroy).not.toHaveBeenCalled();
  });

  it('still retires a budgeted session right after its transaction', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      const connection = await pool.acquire();
      const driver = pool.created[0];
      const query = connection.query.bind(connection);
      (connection as unknown as { query: unknown }).query = (
        input: QueryInput,
        callback: Callback
      ) => {
        const sql = typeof input === 'string' ? input : input.sql;
        if (!sql.startsWith('SELECT @@SESSION'))
          return query(input as never, callback as never);
        setImmediate(() =>
          callback(null, [{ execution_millis: '0', lock_seconds: '50' }])
        );
        return { sql };
      };
      await execBudgetedNativeTransactionally(
        async () => 'committed',
        async () => connection,
        {
          deadlineMonotonicMillis: performance.now() + 2_000,
          maxStatementMillis: 500,
          finalizationReserveMillis: 500,
          lockWaitSeconds: 1
        }
      );
      expect(driver.destroy).toHaveBeenCalledTimes(1);
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });
});
