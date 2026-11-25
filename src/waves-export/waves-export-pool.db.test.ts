import 'reflect-metadata';
import { DROPS_TABLE } from '@/constants';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { withApiSqlExecutor } from './waves-export.db';

/**
 * The export's own pool on MySQL (once in this file: the scope runs once
 * per process): the API's casting, and a session that refuses any write.
 */
describe("the waves export's pool on MySQL", () => {
  it('casts as the API does and refuses any write', async () => {
    const testExecutor = sqlExecutor;
    try {
      await withApiSqlExecutor(async () => {
        const [row] = await sqlExecutor.execute<Record<string, unknown>>(
          `select cast(7 as unsigned) as n,
             @@session.transaction_read_only as read_only`
        );
        expect(row).toEqual({ n: 7, read_only: 1 });
        await expect(
          sqlExecutor.execute(
            `update ${DROPS_TABLE} set title = title where id = :id`,
            { id: 'no-such-drop' }
          )
        ).rejects.toThrow(/READ ONLY/i);
        await expect(
          sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            sqlExecutor.execute(
              `delete from ${DROPS_TABLE} where id = :id`,
              { id: 'no-such-drop' },
              { wrappedConnection: connection }
            )
          )
        ).rejects.toThrow(/READ ONLY/i);
      });
    } finally {
      setSqlExecutor(testExecutor);
    }
  });
});
