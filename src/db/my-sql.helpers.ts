import { ConnectionWrapper } from '../sql-executor';
import * as mysql from 'mysql';
import { PoolConnection, TypeCast } from 'mysql';
import { Time } from '../time';
import { Logger } from '../logging';

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
    if (value === null) {
      return null;
    }

    const res = Number(value);
    return !!res;
  }

  return next();
};

export const CustomTypeCaster: TypeCast = (field, next) =>
  TinyIntToBooleanCaster(field, () => BigIntToNumberCaster(field, next));

function describeQuery(sql: string, params?: Record<string, unknown>): string {
  if (/\bartwork_documentation_[a-z_]+\b/i.test(sql)) {
    return '[private artwork documentation query]';
  }
  const normalized = sql.replace('\n', ' ');
  if (!params) return normalized;
  return `${normalized} with params ${JSON.stringify(params)}`;
}

function privateQueryError(original: unknown): Error {
  const sanitized = new Error(
    'Private artwork documentation database operation failed'
  );
  if (original && typeof original === 'object' && 'code' in original) {
    const code = original.code;
    if (typeof code === 'string' && /^(ER_|PROTOCOL_)[A-Z0-9_]+$/.test(code)) {
      Object.assign(sanitized, { code });
    }
  }
  return sanitized;
}

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
      // Artwork records and archival metadata are private even in infrastructure
      // logs. Bulk inserts can embed values directly in SQL, so hide both the
      // statement and parameters for every query touching this table family.
      const privateArtworkQuery = /\bartwork_documentation_[a-z_]+\b/i.test(
        sql
      );
      const queryDescription = describeQuery(sql, params);
      const queryTook = timer.diffFromNow();
      if (queryTook.gt(Time.seconds(1))) {
        logger.warn(
          `SQL query took ${queryTook.toMillis()} ms to execute: ${queryDescription}`
        );
      }
      if (closeConnection) {
        connection?.release();
      }
      if (err) {
        logger.error(
          privateArtworkQuery
            ? 'Database error executing private artwork documentation query'
            : `Error "${err}" executing SQL query ${queryDescription}\n`
        );
        reject(privateArtworkQuery ? privateQueryError(err) : err);
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
