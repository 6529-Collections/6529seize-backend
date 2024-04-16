import * as mysql from 'mysql';
import { DbQueryOptions, DbPoolName } from './db-query.options';
import { Logger } from './logging';
import { setSqlExecutor, ConnectionWrapper } from './sql-executor';
import { Time } from './time';

let read_pool: mysql.Pool;
let write_pool: mysql.Pool;

const WRITE_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'];

const logger = Logger.get('DB_API');

export async function connect() {
  if (
    !process.env.DB_HOST ||
    !process.env.DB_USER ||
    !process.env.DB_PASS ||
    !process.env.DB_PORT
  ) {
    logger.error('[MISSING CONFIGURATION FOR WRITE DB] [EXITING]');
    process.exit();
  }
  if (
    !process.env.DB_HOST_READ ||
    !process.env.DB_USER_READ ||
    !process.env.DB_PASS_READ ||
    !process.env.DB_PORT
  ) {
    logger.error('[MISSING CONFIGURATION FOR READ DB] [EXITING]');
    process.exit();
  }
  const port = +process.env.DB_PORT;
  write_pool = mysql.createPool({
    connectionLimit: 5,
    connectTimeout: Time.seconds(30).toMillis(),
    acquireTimeout: Time.seconds(30).toMillis(),
    timeout: Time.seconds(30).toMillis(),
    host: process.env.DB_HOST,
    port: port,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    charset: 'utf8mb4',
    database: process.env.DB_NAME
  });
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

function getPoolNameBySql(sql: string): DbPoolName {
  return WRITE_OPERATIONS.some((op) => sql.trim().toUpperCase().startsWith(op))
    ? DbPoolName.WRITE
    : DbPoolName.READ;
}

function getDbConnecionForQuery(
  sql: string,
  forcePool?: DbPoolName
): Promise<mysql.PoolConnection> {
  const poolName = forcePool ?? getPoolNameBySql(sql);
  return getDbConnectionByPoolName(poolName);
}

function getPoolByName(poolName: DbPoolName): mysql.Pool {
  const poolsMap: Record<DbPoolName, mysql.Pool> = {
    [DbPoolName.READ]: read_pool,
    [DbPoolName.WRITE]: write_pool
  };
  return poolsMap[poolName];
}

function getDbConnectionByPoolName(
  poolName: DbPoolName
): Promise<mysql.PoolConnection> {
  const pool = getPoolByName(poolName);
  return new Promise((resolve, reject) => {
    pool.getConnection(function (
      err: mysql.MysqlError,
      dbcon: mysql.PoolConnection
    ) {
      if (err) {
        logger.error(
          `Failed to establish connection to ${poolName} [${JSON.stringify(
            err
          )}]`
        );
        reject(err);
      }
      resolve(dbcon);
    });
  });
}

async function execNativeTransactionally<T>(
  executable: (connectionWrapper: ConnectionWrapper<any>) => Promise<T>
): Promise<T> {
  const connection = await getDbConnectionByPoolName(DbPoolName.WRITE);
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
    externallyGivenConnection ||
    (await getDbConnecionForQuery(sql, options?.forcePool));
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
        reject(err);
      } else {
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      }
    });
  });
}
