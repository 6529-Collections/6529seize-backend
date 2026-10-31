import { performance } from 'node:perf_hooks';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier } from '@/sql-executor';
import { withLoopHealthReadContext } from '@/operational-errors';

/** Diagnostic reads own a short budget and their connection cleanup. They never
 * alter existing DB/Lambda timeout settings or leave an unobserved query running.
 * Callers must use static SQL; all dynamic values belong in params. The driver's
 * single-statement configuration remains the stacked-query safety boundary. */
export function readLoopHealthRows<T>(
  sql: string,
  params?: Record<string, unknown>
): Promise<T[]> {
  if (!/^\s*select\b/i.test(sql)) throw new Error('LOOP_HEALTH_READ_ONLY');
  return withLoopHealthReadContext(() => {
    const db = dbSupplier();
    return db.executeNativeQueriesInTransaction(
      (connection) =>
        db.execute<T>(sql, params, {
          wrappedConnection: connection,
          forcePool: DbPoolName.WRITE,
          bindInvocationContext: true
        }),
      {
        executionBudget: {
          deadlineMonotonicMillis: performance.now() + 2000,
          maxStatementMillis: 1000,
          finalizationReserveMillis: 250,
          lockWaitSeconds: 1
        }
      }
    );
  });
}
