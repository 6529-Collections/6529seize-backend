import * as loopDb from '@/db';
import { Logger } from '@/logging';
import { setSqlExecutor, SqlExecutor, sqlExecutor } from '@/sql-executor';
import { XTdhIdentitySnapshotChangedError } from '@/xtdh/xtdh-identity-snapshot-changed-error';
import {
  createSqlTransactionFixture,
  SQL_TRANSACTION_FIXTURE_TABLE,
  SqlTransactionFixtureEntity
} from './sql-transaction-fixture';

const id = 'transaction-failure-log';
const read = `SELECT CAST(version AS CHAR) AS version FROM ${SQL_TRANSACTION_FIXTURE_TABLE} WHERE id=:id`;
const update = `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version=version+1 WHERE id=:id`;

describe('loop (db.ts) transaction failure logging', () => {
  let observer: SqlExecutor;
  let db: SqlExecutor;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  async function committedVersion(): Promise<string> {
    const rows = await observer.execute<{ version: string }>(read, { id });
    return rows[0].version;
  }

  function failedTransactionLogs(): unknown[] {
    return error.mock.calls
      .map((call) => call[0])
      .filter(
        (message) =>
          typeof message === 'string' &&
          message.startsWith('Database transaction failed')
      );
  }

  beforeEach(async () => {
    observer = sqlExecutor;
    await createSqlTransactionFixture();
    await observer.execute(
      `INSERT INTO ${SQL_TRANSACTION_FIXTURE_TABLE} (id,version) VALUES (:id,1)`,
      { id }
    );
    await loopDb.connect([SqlTransactionFixtureEntity]);
    db = sqlExecutor;
    warn = jest.spyOn(Logger.prototype, 'warn');
    error = jest.spyOn(Logger.prototype, 'error');
  });

  afterEach(async () => {
    warn.mockRestore();
    error.mockRestore();
    try {
      await loopDb.disconnect();
    } finally {
      setSqlExecutor(observer);
      await observer.execute(
        `DROP TABLE IF EXISTS ${SQL_TRANSACTION_FIXTURE_TABLE}`
      );
    }
  });

  it('rolls back and rethrows an xTDH snapshot conflict, logged as a warning', async () => {
    const conflict = new XTdhIdentitySnapshotChangedError();
    await expect(
      db.executeNativeQueriesInTransaction(async (connection) => {
        await db.execute(update, { id }, { wrappedConnection: connection });
        throw conflict;
      })
    ).rejects.toBe(conflict);

    expect(await committedVersion()).toBe('1');
    expect(failedTransactionLogs()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `Database transaction hit a retried conflict; rolling back [${conflict}]`
    );
  });

  it('rolls back and rethrows any other failure, logged as an error as before', async () => {
    const failure = new Error('roll back');
    await expect(
      db.executeNativeQueriesInTransaction(async (connection) => {
        await db.execute(update, { id }, { wrappedConnection: connection });
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(await committedVersion()).toBe('1');
    expect(failedTransactionLogs()).toEqual([
      'Database transaction failed [Error: roll back]'
    ]);
  });
});
