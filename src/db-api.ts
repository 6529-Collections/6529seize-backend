import * as mysql from 'mysql';
import { DbQueryOptions, DbPoolName } from './db-query.options';
import { Logger } from './logging';
import { setSqlExecutor, ConnectionWrapper } from './sql-executor';
import { Time } from './time';

let read_pool: mysql.Pool;

const logger = Logger.get('DB_API');

export async function connect() {
  if (
    !process.env.DB_HOST_READ ||
    !process.env.DB_USER_READ ||
    !process.env.DB_PASS_READ ||
    !process.env.DB_PORT
  ) {
    logger.error('[MISSING CONFIGURATION FOR READ DB] [EXITING]');
    process.exit(1);
  }
  const port = +process.env.DB_PORT;
  read_pool = mysql.createPool({
    connectionLimit: 10,
    connectTimeout: Time.seconds(30).toMillis(),
    acquireTimeout: Time.seconds(30).toMillis(),
    timeout: Time.seconds(30).toMillis(),
    host: process.env.DB_HOST_READ,
    port: port,
    user: process.env.DB_USER_READ,
    password: process.env.DB_PASS_READ,
    charset: 'utf8mb4',
    database: process.env.DB_NAME
  });
  setSqlExecutor({
    execute: (
      sql: string,
      params?: Record<string, any>,
      options?: DbQueryOptions
    ) => execSQLWithParams(sql, params, options),
    executeNativeQueriesInTransaction(executable) {
      return execNativeTransactionally(executable);
    }
  });
  logger.info(`[CONNECTION POOLS CREATED]`);
}

function getDbConnection(): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) => {
    read_pool.getConnection(function (
      err: mysql.MysqlError,
      dbcon: mysql.PoolConnection
    ) {
      if (err) {
        logger.error(`Failed to establish connection [${JSON.stringify(err)}]`);
        reject(err);
      }
      resolve(dbcon);
    });
  });
}

async function execNativeTransactionally<T>(
  executable: (connectionWrapper: ConnectionWrapper<any>) => Promise<T>
): Promise<T> {
  const connection = await getDbConnection();
  try {
    connection.beginTransaction();
    const result = await executable({ connection: connection });
    return await new Promise((resolve, reject) => {
      connection.commit((err: any) => {
        if (err) {
          reject(new Error(err));
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

function prepareStatemant(query: string, values: Record<string, any>) {
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

async function execSQLWithParams<T>(
  sql: string,
  params?: Record<string, any>,
  options?: {
    forcePool?: DbPoolName;
    wrappedConnection?: ConnectionWrapper<mysql.PoolConnection>;
  }
): Promise<T[]> {
  const externallyGivenConnection = options?.wrappedConnection?.connection;
  const connection: mysql.PoolConnection =
    externallyGivenConnection || (await getDbConnection());
  return new Promise((resolve, reject) => {
    connection.config.queryFormat = function (query, values) {
      if (!values) return query;
      return prepareStatemant(query, values);
    };
    connection.query({ sql, values: params }, (err: any, result: T[]) => {
      if (!externallyGivenConnection) {
        connection?.release();
      }
      if (err) {
        logger.error(
          `Error "${err}" executing SQL query ${sql}${
            params ? ` with params ${JSON.stringify(params)}` : ''
          }\n`
        );
        reject(new Error(err));
      } else {
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      }
    });
  });
}
