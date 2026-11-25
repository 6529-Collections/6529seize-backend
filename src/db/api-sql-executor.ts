import * as mysql from 'mysql2';
import { legacyCompetitionGetSql } from '@/competitions/legacy-competition-get-facade';
import {
  createDbAuthTokenSource,
  dbAuthPlugins,
  DbConnectionTarget,
  sslOptionsFor
} from '@/db-iam-auth';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import {
  CustomTypeCaster,
  execBudgetedNativeTransactionally,
  execNativeTransactionally,
  execSQLWithConnection
} from '@/db/my-sql.helpers';
import { createMysqlPool } from '@/db/mysql-pool';
import { Logger } from '@/logging';
import {
  budgetOf,
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import { Time } from '@/time';

const logger = Logger.get('DB_API');

/**
 * A mysql2 pool as the API opens one: its timeouts, utf8mb4, the API's type
 * casting (CustomTypeCaster), TLS for the target and, for an IAM target,
 * its auth token source as a login plugin.
 */
export function createApiDbPool(
  target: DbConnectionTarget,
  port: number,
  connectionLimit: number
): mysql.Pool {
  // The 30 s acquire bound is the former mysqljs acquireTimeout. mysqljs
  // never read the pool-level `timeout` option, so it has no replacement.
  return createMysqlPool(
    {
      connectionLimit,
      connectTimeout: Time.seconds(30).toMillis(),
      host: target.host,
      port: port,
      user: target.user,
      password: target.password,
      charset: 'utf8mb4',
      database: process.env.DB_NAME,
      typeCast: CustomTypeCaster,
      authPlugins: dbAuthPlugins(
        target.iam
          ? createDbAuthTokenSource({
              host: target.host,
              port,
              user: target.user
            })
          : null,
        (error) =>
          logger.error(
            `[DB IAM TOKEN SIGNING FAILED] [${target.host}] ${error}`
          )
      ),
      ...sslOptionsFor(target)
    },
    { acquireTimeoutMs: Time.seconds(30).toMillis() }
  );
}

/** A connection of `pool`, logged and rejected when the pool has none. */
export function apiDbConnection(
  pool: mysql.Pool,
  poolName: DbPoolName
): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) => {
    pool.getConnection(function (
      err: NodeJS.ErrnoException | null,
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

/** Where the API's executor sends a statement. */
export interface ApiSqlPools {
  /** The pool of a statement outside a transaction, unless options force one. */
  poolFor(sql: string): DbPoolName;
  /** A connection of a pool. */
  connection(pool: DbPoolName): Promise<mysql.PoolConnection>;
}

/**
 * The API's SQL executor: every statement goes through the legacy GET
 * view's rewrite (legacyCompetitionGetSql, which changes nothing outside
 * its scope) and the mysql helpers, which cast types as the API does
 * (CustomTypeCaster, or the legacy view's caster inside its scope);
 * transactions run on the write pool. The API server and the waves export
 * both read through it.
 */
export function apiSqlExecutor(pools: ApiSqlPools): SqlExecutor {
  class ApiSqlExecutor extends SqlExecutor {
    async execute<T>(
      sql: string,
      params?: Record<string, any>,
      options?: DbQueryOptions
    ) {
      if (
        (options?.executionBudgetToken || options?.statementLimits) &&
        !options.wrappedConnection?.connection
      ) {
        throw new Error(
          'SQL budget options require their bound transaction connection'
        );
      }
      const suppliedConnection = options?.wrappedConnection?.connection;
      const pool = options?.forcePool ?? pools.poolFor(sql);
      return await execSQLWithConnection<T>(
        legacyCompetitionGetSql(sql),
        suppliedConnection
          ? { connection: suppliedConnection }
          : { pool, acquire: () => pools.connection(pool) },
        params,
        options
      );
    }

    async executeNativeQueriesInTransaction<T>(
      executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>,
      options?: SqlTransactionOptions
    ) {
      const budget = budgetOf(options);
      if (budget) {
        return execBudgetedNativeTransactionally(
          executable,
          () => pools.connection(DbPoolName.WRITE),
          budget
        );
      }
      return pools
        .connection(DbPoolName.WRITE)
        .then((con) => execNativeTransactionally(executable, con, options));
    }
  }
  return new ApiSqlExecutor();
}
