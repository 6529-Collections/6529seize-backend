import { ConnectionWrapper, SqlTransactionOptions } from '../sql-executor';
import * as mysql from 'mysql';
import { PoolConnection, TypeCast } from 'mysql';
import { Time } from '../time';
import { Logger } from '../logging';
import {
  executeBudgetedSqlTransaction,
  withSqlBudgetQueryOptions,
  SqlBudgetQueryOptions,
  SqlExecutionBudgetExceededError
} from '@/db/sql-execution-budget';

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

type PrivateQueryFamily =
  | 'artwork documentation'
  | 'market depth'
  | 'content moderation'
  | 'CMS agent';

function privateQueryFamily(sql: string): PrivateQueryFamily | null {
  if (
    /\b(?:content_moderation_[a-z_]+|abusiveness_detection_results)\b/i.test(
      sql
    )
  ) {
    return 'content moderation';
  }
  if (/\bartwork_documentation_[a-z_]+\b/i.test(sql)) {
    return 'artwork documentation';
  }
  if (/\bmarket_depth_[a-z_]+\b/i.test(sql)) {
    return 'market depth';
  }
  if (/\bprofile_cms_agent_(?:grants|proposals|events)\b/i.test(sql)) {
    return 'CMS agent';
  }
  return null;
}

function describeQuery(sql: string, params?: Record<string, unknown>): string {
  const family = privateQueryFamily(sql);
  if (family === 'artwork documentation') {
    return '[private artwork documentation query]';
  }
  if (family === 'market depth') return '[private market depth query]';
  if (family === 'CMS agent') return '[private CMS agent query]';
  if (family === 'content moderation')
    return '[private content moderation query]';
  const normalized = sql.replace('\n', ' ');
  if (!params) return normalized;
  return `${normalized} with params ${JSON.stringify(params)}`;
}

function privateQueryError(
  original: unknown,
  family: PrivateQueryFamily
): Error {
  const sanitized = new Error(`Private ${family} database operation failed`);
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
  connection: PoolConnection,
  options?: SqlTransactionOptions
): Promise<T> {
  if (options?.executionBudget) {
    let accepted = false;
    try {
      return await execBudgetedNativeTransactionally(
        executable,
        () => {
          accepted = true;
          return Promise.resolve(connection);
        },
        options.executionBudget
      );
    } finally {
      if (!accepted) connection.release();
    }
  }
  try {
    if (options?.isolationLevel) {
      await beginIsolatedTransaction(connection, options);
    } else {
      // Preserve the existing lifecycle for legacy callers. Membership always
      // opts into the awaited BEGIN/rollback path; changing all legacy callers
      // requires its own compatibility validation and deployment inventory.
      connection.beginTransaction();
    }
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
    if (options?.isolationLevel) {
      await new Promise<void>((resolve) =>
        connection.rollback(() => resolve())
      );
    } else {
      connection.rollback();
    }
    throw e;
  } finally {
    connection.release();
  }
}

export function execBudgetedNativeTransactionally<T>(
  executable: (
    connection: ConnectionWrapper<mysql.PoolConnection>
  ) => Promise<T>,
  acquire: () => Promise<mysql.PoolConnection>,
  budget: NonNullable<SqlTransactionOptions['executionBudget']>
): Promise<T> {
  return executeBudgetedSqlTransaction(
    async () => {
      const connection = await acquire();
      return {
        handle: connection,
        physical: connection,
        release: () => connection.release()
      };
    },
    budget,
    (handle) => executable({ connection: handle as mysql.PoolConnection })
  );
}

async function beginIsolatedTransaction(
  connection: PoolConnection,
  options: SqlTransactionOptions
): Promise<void> {
  if (options.isolationLevel !== 'REPEATABLE READ') {
    throw new Error('Unsupported explicit transaction isolation');
  }
  // SET TRANSACTION applies to the next transaction only, avoiding pooled
  // connection session-setting leaks into unrelated legacy requests.
  await new Promise<void>((resolve, reject) => {
    connection.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      (error) => (error ? reject(error) : resolve())
    );
  });
  await new Promise<void>((resolve, reject) => {
    connection.beginTransaction((error) => (error ? reject(error) : resolve()));
  });
}

export async function execSQLWithParams<T>(
  sql: string,
  connection: mysql.PoolConnection,
  closeConnection: boolean,
  params?: Record<string, any>,
  options?: SqlBudgetQueryOptions
): Promise<T[]> {
  return withSqlBudgetQueryOptions(
    connection,
    options,
    () =>
      new Promise((resolve, reject) => {
        connection.config.queryFormat = function (query, values) {
          if (!values) return query;
          return prepareStatement(query, values);
        };
        const timer = Time.now();
        connection.query({ sql, values: params }, (err: any, result: T[]) => {
          // Artwork records and archival metadata are private even in infrastructure
          // logs. Bulk inserts can embed values directly in SQL, so hide both the
          // statement and parameters for every query touching this table family.
          const privateFamily = privateQueryFamily(sql);
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
              err instanceof SqlExecutionBudgetExceededError
                ? `${err.code} phase=${err.phase} commit=${err.commitOutcome}`
                : privateFamily
                  ? `Database error executing private ${privateFamily} query`
                  : `Error "${err}" executing SQL query ${queryDescription}\n`
            );
            reject(privateFamily ? privateQueryError(err, privateFamily) : err);
          } else {
            resolve(Object.values(JSON.parse(JSON.stringify(result))));
          }
        });
      })
  );
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
