import { AsyncLocalStorage } from 'node:async_hooks';
import { DbPoolName } from '@/db-query.options';

const primaryReads = new AsyncLocalStorage<true>();

/**
 * Runs `work` with its pooled reads sent to the primary instead of the read
 * replica, without a transaction: each query takes its own pooled primary
 * connection, so a read that fans out in parallel stays parallel.
 *
 * For reading rows this invocation has just committed, which the replica may
 * not have yet. Queries that pass a connection or an explicit pool are
 * unaffected.
 */
export function withPrimaryReads<T>(work: () => Promise<T>): Promise<T> {
  return primaryReads.run(true, work);
}

/** The pool for a query that names none: the primary inside the scope. */
export function poolForUnboundQuery(sqlDefault: DbPoolName): DbPoolName {
  return primaryReads.getStore() === true ? DbPoolName.WRITE : sqlDefault;
}
