export interface SqlExecutor {
  execute: (sql: string, params?: Record<string, any>) => Promise<any>;
}

export let sqlExecutor!: SqlExecutor;

export function setSqlExecutor(executor: SqlExecutor) {
  sqlExecutor = executor;
}
