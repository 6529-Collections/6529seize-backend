import type { DataSource, QueryRunner } from 'typeorm';

/** One secondary index installed with online DDL instead of entity sync. */
export interface OnlineIndexSpec {
  readonly table: string;
  readonly index: string;
  readonly columns: readonly string[];
  /** Names the index in errors, e.g. "Wave score input index". */
  readonly label: string;
}

interface IndexColumn {
  readonly column_name: string;
  readonly non_unique: number | string;
  readonly sub_part: number | null;
  readonly index_type: string;
  readonly is_visible: string;
  readonly collation: string;
}

async function indexExists(
  runner: QueryRunner,
  spec: OnlineIndexSpec
): Promise<boolean> {
  const columns: IndexColumn[] = await runner.query(
    `SELECT column_name AS column_name, non_unique AS non_unique,
            sub_part AS sub_part, index_type AS index_type,
            is_visible AS is_visible, collation AS collation
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     ORDER BY seq_in_index`,
    [spec.table, spec.index]
  );
  if (!columns.length) return false;
  if (
    columns.length !== spec.columns.length ||
    columns.some(
      (column, index) =>
        column.column_name !== spec.columns[index] ||
        Number(column.non_unique) !== 1 ||
        column.sub_part !== null ||
        column.index_type !== 'BTREE' ||
        column.is_visible !== 'YES' ||
        column.collation !== 'A'
    )
  ) {
    throw new Error(`${spec.label} is incompatible`);
  }
  return true;
}

/**
 * Adds only this index, with ALGORITHM=INPLACE, LOCK=NONE: writes continue
 * during the build. Refuses a blocking algorithm or an incompatible existing
 * index, and waits at most 2 s for the brief metadata locks online DDL takes.
 * Returns 1 when the index was added, 0 when it already existed.
 */
export async function applyOnlineIndex(
  spec: OnlineIndexSpec,
  source: DataSource
): Promise<number> {
  const quoted = spec.columns.map((column) => `\`${column}\``).join(', ');
  const addIndex = `ALTER TABLE \`${spec.table}\` ADD INDEX \`${spec.index}\` (${quoted}), ALGORITHM=INPLACE, LOCK=NONE`;
  const runner = source.createQueryRunner('master');
  let priorLockWaitTimeout: number | undefined;
  try {
    if (!(await runner.hasTable(spec.table)))
      throw new Error(`${spec.label} requires an existing ${spec.table} table`);
    if (await indexExists(runner, spec)) return 0;
    const [settings]: { lock_wait_timeout: number | string }[] =
      await runner.query(
        'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout'
      );
    const timeout = Number(settings.lock_wait_timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 31536000)
      throw new Error('Invalid session metadata lock timeout');
    priorLockWaitTimeout = timeout;
    // Online DDL still briefly acquires metadata locks. Fail promptly if busy.
    await runner.query('SET SESSION lock_wait_timeout = 2');
    await runner.query(addIndex);
    if (!(await indexExists(runner, spec)))
      throw new Error(`${spec.label} was not created`);
    return 1;
  } finally {
    try {
      if (priorLockWaitTimeout !== undefined)
        await runner.query('SET SESSION lock_wait_timeout = ?', [
          priorLockWaitTimeout
        ]);
    } finally {
      await runner.release();
    }
  }
}
