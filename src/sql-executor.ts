import { DbQueryOptions } from './db-query.options';
import { RequestContext } from './request.context';

import * as mysql from 'mysql';

export interface ConnectionWrapper<CONNECTION_TYPE> {
  readonly connection: CONNECTION_TYPE;
}

export type BulkUpsertOpts = {
  chunkSize?: number; // default 1000
  connection?: ConnectionWrapper<any>; // optional wrapped connection
};

export type BulkInsertOpts = {
  chunkSize?: number;
  connection?: ConnectionWrapper<any>;
  ignoreDuplicates?: boolean; // default false
};

export abstract class SqlExecutor {
  abstract execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]>;

  abstract executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T>;

  async oneOrNull<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T | null> {
    return this.execute(sql, params, options).then((r) => r[0] ?? null);
  }

  public async bulkInsert(
    table: string,
    entities: any[],
    insertCols: string[],
    ctx?: RequestContext,
    opts: BulkInsertOpts = {}
  ): Promise<void> {
    const rows = entities as unknown as Array<Record<string, any>>;
    if (!rows.length) return;

    const chunkSize = opts.chunkSize ?? 1000;
    const timerName = `bulkInsert:${table}`;
    const ignore = opts.ignoreDuplicates === true;

    ctx?.timer?.start(timerName);
    try {
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);

        const header =
          '(' + insertCols.map((c) => '`' + c + '`').join(', ') + ')';
        const values = chunk
          .map(
            (r) =>
              `(${insertCols.map((c) => mysql.escape(r[c] ?? null)).join(', ')})`
          )
          .join(', ');

        const sql = `
        INSERT ${ignore ? 'IGNORE ' : ''}INTO ${table}
        ${header}
        VALUES ${values}
      `;
        const connection = opts.connection ?? ctx?.connection;
        await this.execute(sql, undefined, { wrappedConnection: connection });
      }
    } finally {
      ctx?.timer?.stop(timerName);
    }
  }

  public async bulkUpsert(
    table: string,
    entities: any[],
    insertCols: string[],
    updateCols: string[] = [],
    ctx?: RequestContext,
    opts: BulkUpsertOpts = {}
  ): Promise<void> {
    const rows = entities as unknown as Array<Record<string, any>>;
    if (!rows.length) return;

    const chunkSize = opts.chunkSize ?? 1000;
    const timerName = `bulkUpsert:${table}`;
    ctx?.timer?.start(timerName);

    try {
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);

        const header = `(${insertCols.map((c) => '`' + c + '`').join(', ')})`;
        const values = chunk
          .map(
            (r) =>
              `(${insertCols.map((c) => mysql.escape(r[c] ?? null)).join(', ')})`
          )
          .join(', ');

        // INSERT ... VALUES ... AS new ON DUPLICATE KEY UPDATE ...
        // If no updateCols were provided, fall back to INSERT IGNORE (skip duplicates).
        const sql =
          updateCols.length === 0
            ? `
              INSERT IGNORE INTO ${table}
              ${header}
              VALUES ${values}
            `
            : `
              INSERT INTO ${table}
              ${header}
              VALUES ${values}
              AS new
              ON DUPLICATE KEY UPDATE
              ${updateCols.map((c) => `\`${c}\` = new.\`${c}\``).join(', ')}
            `;
        const connection = opts.connection ?? ctx?.connection;
        await this.execute(sql, undefined, {
          wrappedConnection: connection
        });
      }
    } finally {
      ctx?.timer?.stop(timerName);
    }
  }
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
    return +id;
  }
}
