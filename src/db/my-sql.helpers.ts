import { ConnectionWrapper } from '../sql-executor';
import * as mysql from 'mysql';
import { PoolConnection, TypeCast } from 'mysql';
import { Time } from '../time';
import { Logger } from '../logging';
import { RequestContext } from '../request.context';

const logger = Logger.get('MYSQL_HELPERS');

const BigIntToNumberCaster: TypeCast = function castField(field, next) {
  if (field.type === 'LONGLONG') {
    const text = field.string();

    if (text === null) return null;

    const num = Number(text);

    if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
      return BigInt(text);
    }
    return num;
  }
  return next();
};

const TinyIntToBooleanCaster: TypeCast = function castField(field, next) {
  if (field.type === 'TINY') {
    const value = field.string();
    if (value !== null) {
      const res = Number(value);
      return !!res;
    }

    const bytes = field.buffer();
    if (!bytes || bytes.length === 0) {
      return null;
    }
    return !!bytes.readUInt8(0);
  }

  return next();
};

export const CustomTypeCaster: TypeCast = (field, next) =>
  TinyIntToBooleanCaster(field, () => BigIntToNumberCaster(field, next));

export async function execNativeTransactionally<T>(
  executable: (connectionWrapper: ConnectionWrapper<any>) => Promise<T>,
  connection: PoolConnection
): Promise<T> {
  try {
    connection.beginTransaction();
    const result = await executable({ connection: connection });
    return await new Promise((resolve, reject) => {
      connection.commit((err: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  } catch (e) {
    connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

export async function execSQLWithParams<T>(
  sql: string,
  connection: mysql.PoolConnection,
  closeConnection: boolean,
  params?: Record<string, any>
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    connection.config.queryFormat = function (query, values) {
      if (!values) return query;
      return prepareStatement(query, values);
    };
    const timer = Time.now();
    connection.query({ sql, values: params }, (err: any, result: T[]) => {
      const queryTook = timer.diffFromNow();
      if (queryTook.gt(Time.seconds(1))) {
        logger.warn(
          `SQL query took ${queryTook.toMillis()} ms to execute: ${sql.replace(
            '\n',
            ' '
          )}${params ? ` with params ${JSON.stringify(params)}` : ''}`
        );
      }
      if (closeConnection) {
        connection?.release();
      }
      if (err) {
        logger.error(
          `Error "${err}" executing SQL query ${sql.replace('\n', ' ')}${
            params ? ` with params ${JSON.stringify(params)}` : ''
          }\n`
        );
        reject(err);
      } else {
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      }
    });
  });
}

function prepareStatement(query: string, values: Record<string, any>) {
  return query.replace(/:(\w+)/g, function (txt: any, key: any) {
    if (values.hasOwnProperty(key)) {
      const value = values[key];
      if (Array.isArray(value)) {
        return value.map((v) => mysql.escape(v)).join(', ');
      }
      return mysql.escape(value);
    }
    return txt;
  });
}

type BulkUpsertOpts = {
  chunkSize?: number; // default 1000
  connection?: ConnectionWrapper<any>; // optional wrapped connection
};

export async function bulkUpsert(
  db: {
    execute: (
      sql: string,
      params?: any,
      opts?: { wrappedConnection?: ConnectionWrapper<any> }
    ) => Promise<any>;
  },
  table: string,
  rows: Array<Record<string, any>>,
  insertCols: string[],
  updateCols: string[] = [],
  ctx?: RequestContext,
  opts: BulkUpsertOpts = {}
): Promise<void> {
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

      await db.execute(
        sql,
        undefined,
        opts.connection ? { wrappedConnection: opts.connection } : undefined
      );
    }
  } finally {
    ctx?.timer?.stop(timerName);
  }
}
