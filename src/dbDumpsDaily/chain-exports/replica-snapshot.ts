import * as mysql from 'mysql';
import { mysqlSslConnectionOptions } from '@/db-ssl';
import { DbQueryOptions } from '@/db-query.options';
import { CustomTypeCaster, execSQLWithConnection } from '@/db/my-sql.helpers';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';

/**
 * The chain exports (dbDumpsDaily jobs) read 6529.io's database only through
 * the read replica, in one read-only transaction with a consistent snapshot.
 * Nothing here writes, and nothing sets the global SQL executor, so no other
 * code in the invocation can reach the primary by accident.
 */

export class ReplicaGuardError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ReplicaGuardError';
  }
}

export interface ReplicaTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The read replica's connection settings from the shared secret. Refuses
 * unless DB_HOST and DB_HOST_READ are both set and differ.
 */
export function replicaTarget(env: Env = process.env): ReplicaTarget {
  const host = env.DB_HOST_READ?.trim();
  const primary = env.DB_HOST?.trim();
  if (!host) {
    throw new ReplicaGuardError(
      'DB_HOST_READ is not set: the export runs only on the read replica'
    );
  }
  if (!primary) {
    throw new ReplicaGuardError(
      'DB_HOST is not set: without it the export cannot tell the replica from the primary'
    );
  }
  if (host.toLowerCase() === primary.toLowerCase()) {
    throw new ReplicaGuardError(
      'DB_HOST_READ is the primary (DB_HOST): the export runs only on the read replica'
    );
  }
  const port = Number(env.DB_PORT);
  const user = env.DB_USER_READ;
  const password = env.DB_PASS_READ;
  const database = env.DB_NAME;
  if (!Number.isSafeInteger(port) || port <= 0 || !user || !password) {
    throw new ReplicaGuardError(
      'DB_PORT, DB_USER_READ and DB_PASS_READ must be set for the read replica'
    );
  }
  if (!database) {
    throw new ReplicaGuardError('DB_NAME is not set');
  }
  return { host, port, user, password, database };
}

/** What the server said about the transaction the export read in. */
export interface ReadOnlyEvidence {
  /** The replica host the export connected to (DB_HOST_READ). */
  readonly host: string;
  /** The session's transaction access mode: true means READ ONLY. */
  readonly transactionReadOnly: boolean;
  /** The server's global read_only, or null when it couldn't be read. */
  readonly serverReadOnly: boolean | null;
  /** Aurora readers report innodb_read_only; null when not available. */
  readonly innodbReadOnly: boolean | null;
  /** The server's clock (UTC) when the snapshot was taken. */
  readonly snapshotAt: string;
  /**
   * How far this Aurora reader was behind the writer at the snapshot, in
   * milliseconds, from information_schema.replica_host_status; null when
   * that can't be read (not Aurora, or no row for this server).
   */
  readonly replicaLagMs: number | null;
  /** Why replicaLagMs is null: the server's error code and message. */
  readonly replicaLagError: string | null;
}

export interface ReadOnlySnapshot {
  readonly executor: SqlExecutor;
  readonly evidence: ReadOnlyEvidence;
  /** Ends the transaction (nothing was written) and closes the connection. */
  close(): Promise<void>;
}

const READ_STATEMENT = /^\s*(\(\s*)?(select|with)\b/i;

/** Runs SELECTs on the snapshot's one connection; refuses anything else. */
export class ReadOnlySnapshotExecutor extends SqlExecutor {
  constructor(private readonly connection: mysql.PoolConnection) {
    super();
  }

  async execute<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    if (!READ_STATEMENT.test(sql)) {
      throw new Error('The export snapshot runs only SELECT statements');
    }
    return execSQLWithConnection<T>(
      sql,
      { connection: this.connection },
      params,
      { ...options, wrappedConnection: undefined }
    );
  }

  async executeNativeQueriesInTransaction<T>(
    _executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    throw new Error('The export snapshot cannot open a write transaction');
  }
}

/**
 * This Aurora reader's lag behind the writer. The alias is not `lag`: LAG
 * is a reserved word since MySQL 8.0.2, and `AS lag` fails to parse.
 */
export const REPLICA_LAG_SQL =
  'SELECT REPLICA_LAG_IN_MILLISECONDS AS lag_ms FROM information_schema.replica_host_status WHERE SERVER_ID = @@aurora_server_id';

/** The lag in milliseconds, or null with the reason it couldn't be read. */
export interface ReplicaLagReading {
  readonly lagMs: number | null;
  readonly error: string | null;
}

/** A server error as `CODE errno: message`. */
function sqlErrorText(error: unknown): string {
  const { code, errno, sqlMessage, message } = (error ?? {}) as {
    code?: unknown;
    errno?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  const id = [code, errno].filter((it) => it !== undefined).join(' ');
  const text = String(sqlMessage ?? message ?? error);
  return id ? `${id}: ${text}` : text;
}

/**
 * Reads the lag on the snapshot's connection. A server that isn't Aurora
 * has neither the table nor the variable (MySQL errors 1109 and 1193); the
 * error is kept, never swallowed, so a parse error can't pass as "not
 * Aurora".
 */
export async function readReplicaLag(
  connection: Queryable
): Promise<ReplicaLagReading> {
  let row: any;
  try {
    [row] = await query(connection, REPLICA_LAG_SQL);
  } catch (error) {
    return { lagMs: null, error: sqlErrorText(error) };
  }
  if (row === undefined) {
    return {
      lagMs: null,
      error: 'information_schema.replica_host_status has no row for this server'
    };
  }
  const value = Number(row.lag_ms);
  if (
    row.lag_ms === null ||
    row.lag_ms === undefined ||
    !Number.isFinite(value)
  ) {
    return {
      lagMs: null,
      error: `REPLICA_LAG_IN_MILLISECONDS is ${String(row.lag_ms)}`
    };
  }
  return { lagMs: value, error: null };
}

type Queryable = Pick<mysql.Connection, 'query'>;

function query(connection: Queryable, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) =>
    connection.query(sql, (error, rows) =>
      error ? reject(error) : resolve(rows as any[])
    )
  );
}

function flag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return Number(value) === 1;
}

/**
 * Opens one connection to the replica and starts the export's transaction:
 * UTC session time, REPEATABLE READ, READ ONLY, with a consistent snapshot,
 * so every read sees the database as it was at one moment.
 */
export async function openReadOnlySnapshot(
  target: ReplicaTarget,
  createPool: (config: mysql.PoolConfig) => mysql.Pool = mysql.createPool
): Promise<ReadOnlySnapshot> {
  const pool = createPool({
    connectionLimit: 1,
    connectTimeout: Time.seconds(30).toMillis(),
    acquireTimeout: Time.seconds(30).toMillis(),
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    charset: 'utf8mb4',
    typeCast: CustomTypeCaster,
    ...mysqlSslConnectionOptions()
  });
  const endPool = () =>
    new Promise<void>((resolve) => pool.end(() => resolve()));
  let connection: mysql.PoolConnection;
  try {
    connection = await new Promise<mysql.PoolConnection>((resolve, reject) =>
      pool.getConnection((error, conn) =>
        error ? reject(error) : resolve(conn)
      )
    );
  } catch (error) {
    await endPool();
    throw error;
  }
  const release = async () => {
    try {
      await query(connection, 'ROLLBACK');
    } finally {
      connection.release();
      await endPool();
    }
  };
  try {
    await query(connection, "SET SESSION time_zone = '+00:00'");
    await query(
      connection,
      'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ'
    );
    await query(connection, 'SET SESSION TRANSACTION READ ONLY');
    await query(
      connection,
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'
    );
    const [mode] = await query(
      connection,
      'SELECT @@SESSION.transaction_read_only AS tro, @@GLOBAL.read_only AS ro'
    );
    let innodb: boolean | null = null;
    try {
      const [row] = await query(
        connection,
        'SELECT @@GLOBAL.innodb_read_only AS iro'
      );
      innodb = flag(row?.iro);
    } catch {
      innodb = null;
    }
    const transactionReadOnly = flag(mode?.tro) === true;
    const serverReadOnly = flag(mode?.ro);
    if (!transactionReadOnly) {
      throw new ReplicaGuardError(
        'The export transaction did not start READ ONLY'
      );
    }
    // A reader endpoint can route to the writer when no reader is up: only
    // a server that is itself read-only is the replica.
    if (serverReadOnly !== true && innodb !== true) {
      throw new ReplicaGuardError(
        `${target.host} is not a read-only server (read_only and innodb_read_only both off): the export runs only on the read replica`
      );
    }
    // The snapshot's moment on the server's clock (the session is in UTC).
    const [clock] = await query(
      connection,
      'SELECT ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS ms'
    );
    const snapshotMs = Number(clock?.ms);
    if (!Number.isSafeInteger(snapshotMs) || snapshotMs <= 0) {
      throw new ReplicaGuardError("The server's clock could not be read");
    }
    const lag = await readReplicaLag(connection);
    const evidence: ReadOnlyEvidence = {
      host: target.host,
      transactionReadOnly,
      serverReadOnly,
      innodbReadOnly: innodb,
      snapshotAt: new Date(snapshotMs).toISOString(),
      replicaLagMs: lag.lagMs,
      replicaLagError: lag.error
    };
    return {
      executor: new ReadOnlySnapshotExecutor(connection),
      evidence,
      close: release
    };
  } catch (error) {
    // A failed rollback or close must not hide why the snapshot was refused.
    await release().catch(() => undefined);
    throw error;
  }
}
