import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import {
  ConnectionWrapper,
  dbSupplier,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';

/**
 * The SQL executor the mirror reads and writes through: every statement
 * outside a transaction goes to the writer (forcePool WRITE), not a read
 * replica, so a plan never rests on a replica that lags the index or the
 * rows the mirror wrote a run before.
 */
export class WriterPoolExecutor extends SqlExecutor {
  constructor(private readonly inner: () => SqlExecutor = dbSupplier) {
    super();
  }

  execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    return this.inner().execute<T>(
      sql,
      params,
      options?.wrappedConnection
        ? options
        : { ...options, forcePool: DbPoolName.WRITE }
    );
  }

  executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return this.inner().executeNativeQueriesInTransaction(executable, options);
  }

  getAffectedRows(result: any): number {
    return this.inner().getAffectedRows(result);
  }
}

export const writerPoolExecutor = new WriterPoolExecutor();
