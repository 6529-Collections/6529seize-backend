import type { SqlExecutor } from '@/sql-executor';
import type { RequestContext } from '@/request.context';

/** DDL implicitly commits in MySQL. Installation is additive/restartable, not
 * atomic. Fail promptly on metadata contention and restore the pooled session. */
export async function withMigrationSchemaConnection<T>(
  db: SqlExecutor,
  action: (
    ctx: RequestContext & Required<Pick<RequestContext, 'connection'>>
  ) => Promise<T>
): Promise<T> {
  return db.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const previous = await db.oneOrNull<{ timeout: number }>(
      'select @@session.lock_wait_timeout as timeout',
      {},
      options
    );
    if (!previous) throw new Error('Unable to inspect metadata lock timeout');
    await db.execute('set session lock_wait_timeout=5', {}, options);
    try {
      return await action({ connection });
    } finally {
      await db.execute(
        'set session lock_wait_timeout=:timeout',
        { timeout: Number(previous.timeout) },
        options
      );
    }
  });
}
