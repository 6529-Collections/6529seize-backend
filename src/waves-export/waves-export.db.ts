import { timingSafeEqual } from 'node:crypto';
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
  /**
   * The password its pool logs in with (password mode), held only to
   * compare with the next run's: never hashed, written or logged.
   */
  readonly password: string | undefined;
  readonly executor: SqlExecutor;
  readonly pool: mysql.Pool;
} | null = null;

export interface ExportDbScopeOptions {
  /**
   * Keep the pool and its executor after the action, for the next run in
   * this process: the waves export job runs the export once per stage, and
   * a warm function's next invocation runs it again. The DB services keep
   * the executor they first read, so every run reuses this one, on the same
   * server and login only. The last run that doesn't keep it ends it.
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
 * Each of its connections is read-only (EXPORT_SESSION_SQL) before any
 * statement runs on it, so nothing the export runs can write, even on a
 * writer; a connection that can't be made so fails its statement.
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
  const server = serverIdentity(target, port);
  if (
    kept &&
    (kept.server !== server || !samePassword(kept.password, target.password))
  ) {
    throw new Error(
      "The export's DB scope is open on another server or login: DB services keep the executor they first read, so a new server or password needs a new process"
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

/**
 * What a kept scope must match, besides its password: the mode, host, port
 * and user. Only compared and kept with the scope, never written to a
 * message or a log.
 */
function serverIdentity(
  target: ReturnType<typeof resolveDbConnectionTargets>['write'],
  port: number
): string {
  return JSON.stringify([target.iam, target.host, port, target.user]);
}

/**
 * Whether the next run's password is the kept scope's, compared in constant
 * time. Unset (IAM mode) matches only unset; a different length is a
 * different password, so timingSafeEqual never meets unequal lengths. A
 * password rotated in the process's settings is then a refusal, not a kept
 * pool whose new connections log in with the old one and fail.
 */
function samePassword(
  kept: string | undefined,
  next: string | undefined
): boolean {
  if (kept === undefined || next === undefined) return kept === next;
  const a = Buffer.from(kept, 'utf8');
  const b = Buffer.from(next, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function open(
  target: ReturnType<typeof resolveDbConnectionTargets>['write'],
  port: number,
  server: string
) {
  if (target.iam) installMysqlIamAuthSupport();
  const pool = createApiDbPool(target, port, EXPORT_POOL_CONNECTIONS);
  // The pool emits 'connection' for each new connection (and again after a
  // change of user, as an IAM token refresh does) before handing it out.
  // Each gets the SET first; no statement runs on a connection until its
  // SET has succeeded, and one whose SET failed is destroyed and its
  // statement refused: fail closed, never a wait.
  const readOnly = new WeakMap<mysql.PoolConnection, Promise<void>>();
  pool.on('connection', (connection: mysql.PoolConnection) => {
    const set = new Promise<void>((resolve, reject) =>
      connection.query(EXPORT_SESSION_SQL, (error: mysql.MysqlError | null) =>
        error ? reject(error) : resolve()
      )
    );
    // Awaited when the connection is handed out; never unhandled meanwhile.
    set.catch(() => undefined);
    readOnly.set(connection, set);
  });
  const readOnlyConnection = async (name: DbPoolName) => {
    const connection = await apiDbConnection(pool, name);
    try {
      const set = readOnly.get(connection);
      if (!set) throw new Error('no read-only session');
      await set;
    } catch (error) {
      connection.destroy();
      throw new Error(
        `An export connection could not be made read-only: ${(error as { code?: string }).code ?? 'unknown'}`
      );
    }
    return connection;
  };
  const executor = apiSqlExecutor({
    // One pool, a reader's: logged as READ.
    poolFor: () => DbPoolName.READ,
    connection: readOnlyConnection
  });
  return { server, password: target.password, executor, pool };
}
