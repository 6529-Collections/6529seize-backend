import { performance } from 'node:perf_hooks';
import * as apiDb from '@/db-api';
import * as loopDb from '@/db';
import {
  assertSqlWorkBudget,
  SqlExecutionBudgetExceededError
} from '@/db/sql-execution-budget';
import {
  createSqlTransactionFixture,
  SQL_TRANSACTION_FIXTURE_TABLE,
  SqlTransactionFixtureEntity
} from '@/db/sql-transaction-fixture';
import { setSqlExecutor, sqlExecutor, SqlExecutor } from '@/sql-executor';
import { hashParityRowsInBudget } from './competition-parity-hash';

describe.each(['API', 'LOOP'])('parity CPU deadline through %s', (adapter) => {
  let observer: SqlExecutor;
  beforeEach(async () => {
    observer = sqlExecutor;
    await createSqlTransactionFixture();
    await observer.execute(
      `INSERT INTO ${SQL_TRANSACTION_FIXTURE_TABLE} (id,version) VALUES ('cpu-fence',1)`
    );
    if (adapter === 'API') await apiDb.connect();
    else await loopDb.connect([SqlTransactionFixtureEntity]);
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

  it('aborts CPU comparison, rolls back work and releases its write fence', async () => {
    const deadline = performance.now() + 1000;
    let checked = false;
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version=2 WHERE id='cpu-fence'`,
            {},
            { wrappedConnection: connection }
          );
          const handle = connection.connection as object;
          await hashParityRowsInBudget([{ id: 1 }], () => {
            assertSqlWorkBudget(handle);
            if (!checked) {
              checked = true;
              // Deliberately exhaust WORK without an outstanding SQL query.
              while (performance.now() < deadline - 245) {
                /* CPU work */
              }
            }
          });
          throw new Error('Expired CPU comparison must not return a hash');
        },
        {
          executionBudget: {
            deadlineMonotonicMillis: deadline,
            maxStatementMillis: 200,
            finalizationReserveMillis: 250,
            lockWaitSeconds: 1
          }
        }
      )
    ).rejects.toMatchObject({
      name: SqlExecutionBudgetExceededError.name,
      phase: 'WORK',
      commitOutcome: 'NOT_SENT',
      connectionDestroyed: true
    });
    expect(checked).toBe(true);
    await observer.executeNativeQueriesInTransaction(
      async (connection) => {
        expect(
          await observer.execute(
            `SELECT CAST(version AS CHAR) version FROM ${SQL_TRANSACTION_FIXTURE_TABLE} WHERE id='cpu-fence' FOR UPDATE`,
            {},
            { wrappedConnection: connection }
          )
        ).toEqual([{ version: '1' }]);
      },
      {
        executionBudget: {
          deadlineMonotonicMillis: performance.now() + 2000,
          maxStatementMillis: 500,
          finalizationReserveMillis: 250,
          lockWaitSeconds: 1
        }
      }
    );
  });
});
