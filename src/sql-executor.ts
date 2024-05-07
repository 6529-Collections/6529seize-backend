import { DbQueryOptions } from './db-query.options';

export interface ConnectionWrapper<CONNECTION_TYPE> {
  readonly connection: CONNECTION_TYPE;
}

export interface SqlExecutor {
  execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]>;

  executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T>;
}

export let sqlExecutor!: SqlExecutor;

export function setSqlExecutor(executor: SqlExecutor) {
  sqlExecutor = executor;
}

export function dbSupplier(): SqlExecutor {
  return sqlExecutor;
}

export abstract class LazyDbAccessCompatibleService {
  private sqlExecutor: SqlExecutor | undefined;

  public constructor(private readonly sqlExecutorGetter: () => SqlExecutor) {}

  protected get db(): SqlExecutor {
    if (!this.sqlExecutor) {
      this.sqlExecutor = this.sqlExecutorGetter();
    }
    return this.sqlExecutor;
  }

  public async executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    return this.db.executeNativeQueriesInTransaction(executable);
  }

  public async getLastInsertId(
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    const id = await this.db
      .execute(`select last_insert_id() as id`, undefined, {
        wrappedConnection: connection
      })
      .then((it) => it[0].id ?? null);
    if (!id) {
      throw new Error('Failed to get last insert id');
    }
    return id;
  }
}
