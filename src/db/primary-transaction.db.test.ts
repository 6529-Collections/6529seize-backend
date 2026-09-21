import * as loopDb from '@/db';
import {
  markPrimaryTransactionFailed,
  primaryQueryOptions,
  withPrimaryTransaction
} from '@/db/primary-transaction';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import {
  SQL_TRANSACTION_FIXTURE_TABLE,
  createSqlTransactionFixture
} from './sql-transaction-fixture';

describe('primary transaction primary snapshots on MySQL', () => {
  beforeEach(createSqlTransactionFixture);
  beforeEach(async () => {
    await sqlExecutor.execute(
      `TRUNCATE TABLE ${SQL_TRANSACTION_FIXTURE_TABLE}`
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SQL_TRANSACTION_FIXTURE_TABLE} (id, version) VALUES ('snapshot-test', 1)`
    );
  });
  afterEach(async () => {
    await sqlExecutor.execute(`DROP TABLE ${SQL_TRANSACTION_FIXTURE_TABLE}`);
  });
  const select = `SELECT CAST(version AS CHAR) AS version
    FROM ${SQL_TRANSACTION_FIXTURE_TABLE}
    WHERE id = 'snapshot-test'`;

  it('holds a coherent page snapshot while locking reads see current committed changes', async () => {
    await withPrimaryTransaction(sqlExecutor, async (ctx) => {
      const options = primaryQueryOptions(ctx);
      expect(await sqlExecutor.execute(select, undefined, options)).toEqual([
        { version: '1' }
      ]);
      // A separate connection commits while the page snapshot is open.
      await sqlExecutor.execute(`UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version = 2
        WHERE id = 'snapshot-test'`);
      expect(await sqlExecutor.execute(select, undefined, options)).toEqual([
        { version: '1' }
      ]);
      expect(
        await sqlExecutor.execute(`${select} FOR UPDATE`, undefined, options)
      ).toEqual([{ version: '2' }]);
    });
    await withPrimaryTransaction(sqlExecutor, async (ctx) => {
      expect(
        await sqlExecutor.execute(select, undefined, primaryQueryOptions(ctx))
      ).toEqual([{ version: '2' }]);
    });
  });

  it('rolls back writes made through the bound connection on callback failure', async () => {
    await expect(
      withPrimaryTransaction(sqlExecutor, async (ctx) => {
        await sqlExecutor.execute(
          `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version = 9
        WHERE id = 'snapshot-test'`,
          undefined,
          primaryQueryOptions(ctx)
        );
        throw new Error('abort scoped work');
      })
    ).rejects.toThrow('abort scoped work');
    expect(await sqlExecutor.execute(select)).toEqual([{ version: '1' }]);
  });

  it('rolls back a real write when the caller catches a marked mutation failure', async () => {
    const failure = new Error('source write failed after partial progress');
    await expect(
      withPrimaryTransaction(sqlExecutor, async (ctx) => {
        try {
          await sqlExecutor.execute(
            `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version = 7
              WHERE id = 'snapshot-test'`,
            undefined,
            primaryQueryOptions(ctx)
          );
          throw failure;
        } catch (error) {
          markPrimaryTransactionFailed(ctx, error);
        }
        return 'caller caught the failure';
      })
    ).rejects.toBe(failure);
    expect(await sqlExecutor.execute(select)).toEqual([{ version: '1' }]);
  });

  it('keeps the same coherent snapshot through the real loop TypeORM adapter', async () => {
    const concurrentWriter = sqlExecutor;
    await loopDb.connect();
    try {
      await withPrimaryTransaction(sqlExecutor, async (ctx) => {
        const options = primaryQueryOptions(ctx);
        expect(await sqlExecutor.execute(select, undefined, options)).toEqual([
          { version: '1' }
        ]);
        await concurrentWriter.execute(
          `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version = 3
              WHERE id = 'snapshot-test'`
        );
        expect(await sqlExecutor.execute(select, undefined, options)).toEqual([
          { version: '1' }
        ]);
        expect(
          await sqlExecutor.execute(`${select} FOR UPDATE`, undefined, options)
        ).toEqual([{ version: '3' }]);
      });
    } finally {
      await loopDb.disconnect();
      setSqlExecutor(concurrentWriter);
    }
  });
});
