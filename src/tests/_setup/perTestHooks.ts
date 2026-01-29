import * as mysql from 'mysql';
import { DbQueryOptions } from '../../db-query.options';
import {
  CustomTypeCaster,
  execNativeTransactionally,
  execSQLWithParams
} from '../../db/my-sql.helpers';
import { env } from '../../env';
import { Logger } from '../../logging';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor
} from '../../sql-executor';
import { Time } from '../../time';

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

class DbImpl extends SqlExecutor {
  async execute<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<any> {
    return options?.wrappedConnection?.connection
      ? execSQLWithParams<T>(
          sql,
          options.wrappedConnection.connection! as mysql.PoolConnection,
          false,
          params
        )
      : getConnectionsFromPool().then((connection) =>
          execSQLWithParams<T>(sql, connection, true, params)
        );
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
  ) {
    return getConnectionsFromPool().then((connection) =>
      execNativeTransactionally(executable, connection)
    );
  }
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

  setSqlExecutor(new DbImpl());
});

afterEach(async () => {
  if (pool) {
    try {
      // Close pool with timeout to prevent hanging
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          try {
            logger.warn('[POOL CLOSE TIMEOUT] Forcing pool cleanup');
          } catch {
            // Ignore - Jest environment may be torn down
          }
          resolve();
        }, 500);
        // Use unref() so timer doesn't keep process alive
        timeoutHandle.unref();
      });

      await Promise.race([
        new Promise<void>((resolve) => {
          pool.end((err) => {
            // Clear timeout if pool closes successfully
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            if (err) {
              try {
                logger.error(`[POOL CLOSE ERROR] ${err}`);
              } catch {
                // Ignore - Jest environment may be torn down
              }
            }
            resolve();
          });
        }),
        timeoutPromise
      ]);
    } catch (error) {
      // Ignore errors during cleanup
      try {
        logger.error(`[POOL CLEANUP ERROR] ${error}`);
      } catch {
        // Ignore - Jest environment may be torn down
      }
    }
    pool = undefined as any;
  }
});
