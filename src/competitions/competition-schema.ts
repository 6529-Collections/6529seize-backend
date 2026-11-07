import type { SqlExecutor } from '@/sql-executor';
import type { RequestContext } from '@/request.context';

/** DDL implicitly commits in MySQL. Installation is additive/restartable, not
 * atomic. Fail promptly on metadata contention and restore the pooled session. */
export async function withCompetitionSchemaConnection<T>(
  db: SqlExecutor,
  action: (
    ctx: RequestContext & Required<Pick<RequestContext, 'connection'>>
  ) => Promise<T>,
  lockWaitSeconds = 5
): Promise<T> {
  if (!Number.isInteger(lockWaitSeconds) || lockWaitSeconds < 1)
    throw new Error('Invalid metadata lock wait');
  return db.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const previous = await db.oneOrNull<{ timeout: number }>(
      'select @@session.lock_wait_timeout as timeout',
      {},
      options
    );
    if (!previous) throw new Error('Unable to inspect metadata lock timeout');
    await db.execute(
      'set session lock_wait_timeout=:lockWaitSeconds',
      { lockWaitSeconds },
      options
    );
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
