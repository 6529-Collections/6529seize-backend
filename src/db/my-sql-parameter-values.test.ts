import type { PoolConnection } from 'mysql';
import { DbPoolName } from '@/db-query.options';
import { SqlParameterValueError } from '@/db/sql-named-parameters';
import { execSQLWithConnection, execSQLWithParams } from './my-sql.helpers';

type Callback = (error: unknown, rows?: unknown) => void;

/** mysql formats synchronously through config.queryFormat inside query(). */
function fakeConnection() {
  const statements: string[] = [];
  const release = jest.fn();
  const connection = {
    config: {} as { queryFormat?: (sql: string, values: unknown) => string },
    release,
    destroy: jest.fn(),
    query(
      input: { sql: string; values?: Record<string, unknown> },
      callback: Callback
    ) {
      const formatted = connection.config.queryFormat
        ? connection.config.queryFormat(input.sql, input.values)
        : input.sql;
      statements.push(formatted);
      setImmediate(() => callback(null, [{ ok: 1 }]));
      return { sql: formatted };
    }
  };
  return {
    connection: connection as unknown as PoolConnection,
    statements,
    release
  };
}

describe('named parameter values in the mysql executor', () => {
  it('binds scalars and flat arrays as before', async () => {
    const driver = fakeConnection();
    await execSQLWithConnection(
      'select * from t where c = :contract and id in (:ids)',
      { pool: DbPoolName.READ, acquire: async () => driver.connection },
      { contract: '0xabc', ids: [1, 2], unused: { ignored: true } }
    );
    expect(driver.statements).toEqual([
      "select * from t where c = '0xabc' and id in (1, 2)"
    ]);
    expect(driver.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an object value before any statement is sent and returns the connection', async () => {
    const driver = fakeConnection();
    await expect(
      execSQLWithConnection(
        'select * from t where c = :contract',
        { pool: DbPoolName.READ, acquire: async () => driver.connection },
        { contract: { contract: 1 } }
      )
    ).rejects.toBeInstanceOf(SqlParameterValueError);
    expect(driver.statements).toEqual([]);
    expect(driver.release).toHaveBeenCalledTimes(1);
  });

  it('leaves a caller-owned connection with its owner on rejection', async () => {
    const driver = fakeConnection();
    await expect(
      execSQLWithParams('select :ids', driver.connection, false, {
        ids: [[1, 2]]
      })
    ).rejects.toBeInstanceOf(SqlParameterValueError);
    expect(driver.statements).toEqual([]);
    expect(driver.release).not.toHaveBeenCalled();
  });
});
