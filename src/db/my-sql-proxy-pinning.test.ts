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
import { isProxySessionPinned } from './proxy-session-pinning';

type Callback = (error: unknown, rows?: unknown) => void;
type QueryInput = string | { sql: string; values?: Record<string, unknown> };

/** Emulates mysql: query() formats synchronously through config.queryFormat. */
function fakeConnection(
  respond: (sql: string) => { error?: unknown; rows?: unknown } = () => ({})
) {
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
      setImmediate(() => callback(error ?? null, rows ?? [{ ok: 1 }]));
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

describe('RDS Proxy pin containment in the API SQL path', () => {
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

  it('labels private statement families without their SQL', async () => {
    const records = captureEmf();
    const driver = fakeConnection();
    await execSQLWithParams(
      'select * from e2ee_devices where id in (:ids)',
      driver.connection,
      true,
      { ids: manyIds }
    );
    expect(records()[0].fingerprint).toBe('[private e2ee messaging query]');
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
