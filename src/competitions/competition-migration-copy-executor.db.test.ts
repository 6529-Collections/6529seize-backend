import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as apiDb from '@/db-api';
import * as loopDb from '@/db';
import {
  createSqlTransactionFixture,
  SQL_TRANSACTION_FIXTURE_TABLE,
  SqlTransactionFixtureEntity
} from '@/db/sql-transaction-fixture';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { setSqlExecutor, SqlExecutor, sqlExecutor } from '@/sql-executor';
import { MigrationCopySqlExecutor } from './competition-migration-copy-executor';

const fixtureId = 'migration-diagnostic-private-row';
const slowQuery = 'SELECT SLEEP(:privateDelay) AS withheld';

describe.each(['API', 'LOOP'])(
  'migration timeout diagnostics through actual %s adapter',
  (adapter) => {
    let observer: SqlExecutor;
    let db: MigrationCopySqlExecutor;
    beforeEach(async () => {
      observer = sqlExecutor;
      await createSqlTransactionFixture();
      await observer.execute(
        `INSERT INTO ${SQL_TRANSACTION_FIXTURE_TABLE} (id,version) VALUES (:id,1)`,
        { id: fixtureId }
      );
      if (adapter === 'API') await apiDb.connect();
      else await loopDb.connect([SqlTransactionFixtureEntity]);
      db = new MigrationCopySqlExecutor(sqlExecutor);
    });
    afterEach(async () => {
      try {
        if (adapter === 'API') await apiDb.disconnect();
        else await loopDb.disconnect();
      } finally {
        setSqlExecutor(observer);
        await observer.execute(
          `DROP TABLE IF EXISTS ${SQL_TRANSACTION_FIXTURE_TABLE}`
        );
      }
    });

    it('retains the failed statement fingerprint on the outer transaction error after rollback', async () => {
      let failure: unknown;
      try {
        await db.executeNativeQueriesInTransaction(
          async (connection) => {
            await db.execute(
              `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version=2 WHERE id=:id`,
              { id: fixtureId },
              { wrappedConnection: connection }
            );
            await db.execute(
              slowQuery,
              { privateDelay: 2 },
              { wrappedConnection: connection }
            );
          },
          {
            executionBudget: {
              deadlineMonotonicMillis: performance.now() + 3_000,
              maxStatementMillis: 100,
              finalizationReserveMillis: 500,
              lockWaitSeconds: 1
            }
          }
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SqlExecutionBudgetExceededError);
      expect(failure).toMatchObject({
        phase: 'WORK',
        commitOutcome: 'NOT_SENT',
        connectionDestroyed: true,
        migrationStatementNumber: 2,
        migrationStatementFingerprint: createHash('sha256')
          .update(slowQuery)
          .digest('hex')
      });
      expect(JSON.stringify(failure)).not.toMatch(
        /migration-diagnostic-private-row|privateDelay|SELECT SLEEP/
      );
      expect(
        await observer.execute(
          `SELECT CAST(version AS CHAR) AS version FROM ${SQL_TRANSACTION_FIXTURE_TABLE} WHERE id=:id`,
          { id: fixtureId }
        )
      ).toEqual([{ version: '1' }]);
    });
  }
);
