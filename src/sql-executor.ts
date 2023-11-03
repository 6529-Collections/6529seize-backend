import { DbQueryOptions } from './db-query.options';

export interface SqlExecutor {
  execute: (
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ) => Promise<any>;
}

export let sqlExecutor!: SqlExecutor;

export function setSqlExecutor(executor: SqlExecutor) {
  sqlExecutor = executor;
}
