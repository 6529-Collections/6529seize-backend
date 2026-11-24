import * as mysql from 'mysql';
import {
  apiDbConnection,
  apiSqlExecutor,
  createApiDbPool
} from '@/db/api-sql-executor';
import {
  installMysqlIamAuthSupport,
  isDbConnectionTargetComplete,
  resolveDbConnectionTargets
} from '@/db-iam-auth';
import { DbPoolName } from '@/db-query.options';
import { setSqlExecutor, SqlExecutor, sqlExecutor } from '@/sql-executor';

/** The export's pool: its stages' concurrency and the lag check, with room. */
const EXPORT_POOL_CONNECTIONS = 10;

/** Every export connection reads only: MySQL refuses a write (1792). */
export const EXPORT_SESSION_SQL = 'SET SESSION TRANSACTION READ ONLY';

let used = false;

/** The process's scope while a caller keeps it open for its next run. */
let kept: {
  readonly server: string;
  readonly executor: SqlExecutor;
  readonly pool: mysql.Pool;
} | null = null;

export interface ExportDbScopeOptions {
  /**
   * Keep the pool and its executor after the action, for the next run in
   * this process: the waves export job runs the export once per stage, and
   * a warm function's next invocation runs it again. The DB services keep
   * the executor they first read, so every run reuses this one, on the same
   * server only. The last run that doesn't keep it ends it.
   */
  readonly keepOpen?: boolean;
}

/**
 * Runs `action` with every SQL statement going through the API's own
 * executor (apiSqlExecutor): the legacy GET view's rewrite inside its scope
 * and the API's type casting, so the export reads what the public API's
 * mappers read, numbers as numbers. A CLI's default DB layer (db.ts,
 * TypeORM) does neither: it gives bigints as text and ignores the view.
 *
 * One pool, on the write-side target (DB_HOST, or DB_IAM_HOST in IAM
 * mode), the server db.ts reads: the export's runbook points it at a
 * reader, and the replica lag check and every stage read that one server.
 * Each of its connections is read-only (EXPORT_SESSION_SQL), so nothing
 * the export runs can write, even on a writer.
 *
 * Once per process. The DB services (LazyDbAccessCompatibleService, such as
 * dropsDb) keep the executor they first read: one first used inside this
 * scope keeps this executor, and its pool, which ends with the scope; one
 * used before it would keep the executor before, without the rewrite or the
 * casting. So nothing may touch a DB service before this runs, and a second
 * scope in the same process is refused; a caller that runs the export again
 * in its process (the waves export job) keeps the one scope open instead
 * (`keepOpen`). Only the global executor is put back afterwards.
 */
export async function withApiSqlExecutor<T>(
  action: () => Promise<T>,
  options: ExportDbScopeOptions = {}
): Promise<T> {
  const target = resolveDbConnectionTargets().write;
  const port = Number(process.env.DB_PORT);
  if (!isDbConnectionTargetComplete(target) || !port) {
    throw new Error(
      'The export needs DB_HOST, DB_USER, DB_PASS and DB_PORT (or the DB_IAM_* settings)'
    );
  }
  const server = JSON.stringify([target.iam, target.host, port, target.user]);
  if (kept && kept.server !== server) {
    throw new Error(
      "The export's DB scope is open on another server: DB services keep the executor they first read"
    );
  }
  if (!kept && used) {
    throw new Error(
      "The export's DB scope runs once per process: DB services keep the executor they first read"
    );
  }
  used = true;
  const scope = kept ?? open(target, port, server);
  const previous = sqlExecutor;
  setSqlExecutor(scope.executor);
  try {
    return await action();
  } finally {
    setSqlExecutor(previous);
    if (options.keepOpen) {
      kept = scope;
    } else {
      kept = null;
      await new Promise<void>((resolve) => scope.pool.end(() => resolve()));
    }
  }
}

function open(
  target: ReturnType<typeof resolveDbConnectionTargets>['write'],
  port: number,
  server: string
) {
  if (target.iam) installMysqlIamAuthSupport();
  const pool = createApiDbPool(target, port, EXPORT_POOL_CONNECTIONS);
  // Runs before anything else on the connection (a connection runs its
  // queries in order). A connection that can't be made read-only is
  // destroyed, so the statement queued after it fails: fail closed.
  pool.on('connection', (connection: mysql.PoolConnection) => {
    connection.query(EXPORT_SESSION_SQL, (error: mysql.MysqlError | null) => {
      if (error) connection.destroy();
    });
  });
  const executor = apiSqlExecutor({
    // One pool, a reader's: logged as READ.
    poolFor: () => DbPoolName.READ,
    connection: (name) => apiDbConnection(pool, name)
  });
  return { server, executor, pool };
}
