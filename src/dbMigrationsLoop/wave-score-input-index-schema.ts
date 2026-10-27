import type { DataSource, QueryRunner } from 'typeorm';
import { getDataSource } from '@/db';
import { DROPS_TABLE } from '@/constants';

const INDEX_NAME = 'idx_drop_wave_author_created';
const COLUMNS = ['wave_id', 'author_id', 'created_at'];
const ADD_INDEX = `ALTER TABLE \`${DROPS_TABLE}\` ADD INDEX \`${INDEX_NAME}\` (\`wave_id\`, \`author_id\`, \`created_at\`), ALGORITHM=INPLACE, LOCK=NONE`;

interface IndexColumn {
  readonly column_name: string;
  readonly non_unique: number | string;
  readonly sub_part: number | null;
  readonly index_type: string;
  readonly is_visible: string;
  readonly collation: string;
}

async function indexExists(runner: QueryRunner): Promise<boolean> {
  const columns: IndexColumn[] = await runner.query(
    `SELECT column_name AS column_name, non_unique AS non_unique,
            sub_part AS sub_part, index_type AS index_type,
            is_visible AS is_visible, collation AS collation
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     ORDER BY seq_in_index`,
    [DROPS_TABLE, INDEX_NAME]
  );
  if (!columns.length) return false;
  if (
    columns.length !== COLUMNS.length ||
    columns.some(
      (column, index) =>
        column.column_name !== COLUMNS[index] ||
        Number(column.non_unique) !== 1 ||
        column.sub_part !== null ||
        column.index_type !== 'BTREE' ||
        column.is_visible !== 'YES' ||
        column.collation !== 'A'
    )
  ) {
    throw new Error('Wave score input index is incompatible');
  }
  return true;
}

/** Add only this index; refuse a blocking DDL algorithm or incompatible state. */
export async function applyWaveScoreInputIndexSchema(
  source: DataSource = getDataSource()
): Promise<number> {
  const runner = source.createQueryRunner('master');
  let priorLockWaitTimeout: number | undefined;
  try {
    if (!(await runner.hasTable(DROPS_TABLE)))
      throw new Error(
        'Wave score input index requires an existing drops table'
      );
    if (await indexExists(runner)) return 0;
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
    await runner.query(ADD_INDEX);
    if (!(await indexExists(runner)))
      throw new Error('Wave score input index was not created');
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
