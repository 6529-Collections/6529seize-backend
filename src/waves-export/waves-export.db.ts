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
 * The executor in place before is put back afterwards.
 */
export async function withApiSqlExecutor<T>(
  action: () => Promise<T>
): Promise<T> {
  const target = resolveDbConnectionTargets().write;
  const port = Number(process.env.DB_PORT);
  if (!isDbConnectionTargetComplete(target) || !port) {
    throw new Error(
      'The export needs DB_HOST, its user and DB_PORT (or the DB_IAM_* settings)'
    );
  }
  if (target.iam) installMysqlIamAuthSupport();
  const pool = createApiDbPool(target, port, EXPORT_POOL_CONNECTIONS);
  const previous = sqlExecutor;
  setSqlExecutor(
    apiSqlExecutor({
      poolFor: () => DbPoolName.WRITE,
      connection: (name) => apiDbConnection(pool, name)
    })
  );
  try {
    return await action();
  } finally {
    setSqlExecutor(previous);
    await new Promise<void>((resolve) => pool.end(() => resolve()));
  }
}
