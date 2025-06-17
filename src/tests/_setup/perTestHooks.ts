import * as mysql from 'mysql';
import { setSqlExecutor } from '../../sql-executor';
import { DbQueryOptions } from '../../db-query.options';
import { Time } from '../../time';
import { env } from '../../env';
import { Logger } from '../../logging';
import {
  CustomTypeCaster,
  execNativeTransactionally,
  execSQLWithParams
} from '../../db/my-sql.helpers';

const logger = Logger.get('TEST');

let pool: mysql.Pool;

function getConnectionsFromPool(): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) => {
    pool.getConnection(function (
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

beforeEach(async () => {
  pool = mysql.createPool({
    connectionLimit: 5,
    connectTimeout: Time.seconds(30).toMillis(),
    acquireTimeout: Time.seconds(30).toMillis(),
    timeout: Time.seconds(30).toMillis(),
    host: env.getStringOrThrow('DB_HOST'),
    port: env.getIntOrThrow('DB_PORT'),
    user: env.getStringOrThrow('DB_USER'),
    password: env.getStringOrThrow('DB_PASS'),
    charset: 'utf8mb4',
    database: env.getStringOrThrow('DB_NAME'),
    typeCast: CustomTypeCaster
  });

  setSqlExecutor({
    execute: <T>(
      sql: string,
      params?: Record<string, any>,
      options?: DbQueryOptions
    ) =>
      options?.wrappedConnection?.connection
        ? execSQLWithParams<T>(
            sql,
            options.wrappedConnection.connection! as mysql.PoolConnection,
            false,
            params
          )
        : getConnectionsFromPool().then((connection) =>
            execSQLWithParams<T>(sql, connection, true, params)
          ),
    executeNativeQueriesInTransaction(executable) {
      return getConnectionsFromPool().then((connection) =>
        execNativeTransactionally(executable, connection)
      );
    },
    oneOrNull: <T>(
      sql: string,
      params?: Record<string, any>,
      options?: DbQueryOptions
    ) =>
      (options?.wrappedConnection?.connection
        ? execSQLWithParams<T>(
            sql,
            options.wrappedConnection.connection! as mysql.PoolConnection,
            false,
            params
          )
        : getConnectionsFromPool().then((connection) =>
            execSQLWithParams<T>(sql, connection, true, params)
          )
      ).then((r) => (r[0] as any) ?? null)
  });
});

afterEach(async () => {
  pool.end();
});
