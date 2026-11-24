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
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';

/** The export's pool: its stages' concurrency and the lag check, with room. */
const EXPORT_POOL_CONNECTIONS = 10;

/** Every export connection reads only: MySQL refuses a write (1792). */
export const EXPORT_SESSION_SQL = 'SET SESSION TRANSACTION READ ONLY';

let used = false;

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
 * call in the same process is refused. Only the global executor is put back
 * afterwards.
 */
export async function withApiSqlExecutor<T>(
  action: () => Promise<T>
): Promise<T> {
  if (used) {
    throw new Error(
      "The export's DB scope runs once per process: DB services keep the executor they first read"
    );
  }
  const target = resolveDbConnectionTargets().write;
  const port = Number(process.env.DB_PORT);
  if (!isDbConnectionTargetComplete(target) || !port) {
    throw new Error(
      'The export needs DB_HOST, DB_USER, DB_PASS and DB_PORT (or the DB_IAM_* settings)'
    );
  }
  used = true;
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
  const previous = sqlExecutor;
  setSqlExecutor(
    apiSqlExecutor({
      // One pool, a reader's: logged as READ.
      poolFor: () => DbPoolName.READ,
      connection: readOnlyConnection
    })
  );
  try {
    return await action();
  } finally {
    setSqlExecutor(previous);
    await new Promise<void>((resolve) => pool.end(() => resolve()));
  }
}
