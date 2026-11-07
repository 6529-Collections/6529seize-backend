import type { DataSource, QueryRunner } from 'typeorm';
import { getDataSource } from '@/db';
import { PROFILE_GROUPS_TABLE } from '@/constants';
import { Logger } from '@/logging';

const logger = Logger.get('PROFILE_GROUPS_COLLATION_SCHEMA');

/**
 * profile_groups was created with utf8mb3_bin columns while every table it is
 * joined with uses the schema default (utf8mb4_0900_ai_ci). A column-to-column
 * comparison across the two converts the profile_groups side, so its indexes
 * cannot be used: the DM blocked-member check and the group identity counts
 * scan the whole table. These operator scopes move the two columns to the
 * schema default (or back), guarded for production:
 *
 * - idempotent: a table already in the requested state is left alone, and any
 *   other shape is refused;
 * - a duplicate preflight refuses keys that would collide under the target
 *   collation (the ids are lowercase ASCII UUIDs, so none are expected);
 * - the ALTER copies the table (a charset change cannot run in place) with
 *   LOCK=SHARED, so reads continue and writes wait for the copy;
 * - a 2 s metadata-lock timeout (the production default is a year) bounds the
 *   queue that forms behind the ALTER while it waits, and lock timeouts are
 *   retried with backoff;
 * - the result is verified before success is reported.
 */
export const PROFILE_GROUPS_TARGET_CHARSET = 'utf8mb4';
export const PROFILE_GROUPS_TARGET_COLLATION = 'utf8mb4_0900_ai_ci';
export const PROFILE_GROUPS_LEGACY_CHARSET = 'utf8mb3';
export const PROFILE_GROUPS_LEGACY_COLLATION = 'utf8mb3_bin';

export type ProfileGroupsCollationDirection = 'convert' | 'revert';

const COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'profile_group_id', type: 'varchar(50)' },
  { name: 'profile_id', type: 'varchar(100)' }
];
const PRIMARY_KEY = ['profile_group_id', 'profile_id'];
const LOCK_WAIT_TIMEOUT_SECONDS = 2;
const MAX_ATTEMPTS = 5;
const ER_LOCK_WAIT_TIMEOUT = 1205;

interface ColumnRow {
  readonly column_name: string;
  readonly column_type: string;
  readonly is_nullable: string;
  readonly character_set_name: string | null;
  readonly collation_name: string | null;
}

interface IndexRow {
  readonly index_name: string;
  readonly column_name: string;
}

type ColumnState = 'legacy' | 'target';

function charsetFor(state: ColumnState): {
  charset: string;
  collation: string;
} {
  return state === 'target'
    ? {
        charset: PROFILE_GROUPS_TARGET_CHARSET,
        collation: PROFILE_GROUPS_TARGET_COLLATION
      }
    : {
        charset: PROFILE_GROUPS_LEGACY_CHARSET,
        collation: PROFILE_GROUPS_LEGACY_COLLATION
      };
}

async function readColumnState(runner: QueryRunner): Promise<ColumnState> {
  const rows: ColumnRow[] = await runner.query(
    `SELECT column_name AS column_name, column_type AS column_type,
            is_nullable AS is_nullable,
            character_set_name AS character_set_name,
            collation_name AS collation_name
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY ordinal_position`,
    [PROFILE_GROUPS_TABLE]
  );
  const shapeMatches =
    rows.length === COLUMNS.length &&
    rows.every(
      (row, index) =>
        row.column_name === COLUMNS[index].name &&
        row.column_type.toLowerCase() === COLUMNS[index].type &&
        row.is_nullable === 'NO'
    );
  if (!shapeMatches) {
    throw new Error('profile_groups columns are incompatible');
  }
  for (const state of ['legacy', 'target'] as const) {
    const { charset, collation } = charsetFor(state);
    if (
      rows.every(
        (row) =>
          row.character_set_name === charset && row.collation_name === collation
      )
    ) {
      return state;
    }
  }
  throw new Error('profile_groups column collations are incompatible');
}

async function readIndexes(runner: QueryRunner): Promise<string> {
  const rows: IndexRow[] = await runner.query(
    `SELECT index_name AS index_name, column_name AS column_name
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY index_name, seq_in_index`,
    [PROFILE_GROUPS_TABLE]
  );
  const primary = rows
    .filter((row) => row.index_name === 'PRIMARY')
    .map((row) => row.column_name);
  if (primary.join(',') !== PRIMARY_KEY.join(',')) {
    throw new Error('profile_groups primary key is incompatible');
  }
  return rows.map((row) => `${row.index_name}:${row.column_name}`).join('|');
}

async function duplicateKeysUnder(
  runner: QueryRunner,
  state: ColumnState
): Promise<number> {
  const { charset, collation } = charsetFor(state);
  const [row]: { duplicates: number | string }[] = await runner.query(
    `SELECT COUNT(*) AS duplicates FROM (
       SELECT CONVERT(profile_group_id USING ${charset}) COLLATE ${collation} AS g,
              CONVERT(profile_id USING ${charset}) COLLATE ${collation} AS p
       FROM \`${PROFILE_GROUPS_TABLE}\`
       GROUP BY g, p
       HAVING COUNT(*) > 1
     ) collisions`
  );
  return Number(row?.duplicates ?? 0);
}

function alterStatement(state: ColumnState): string {
  const { charset, collation } = charsetFor(state);
  const modify = COLUMNS.map(
    (column) =>
      `MODIFY \`${column.name}\` ${column.type} CHARACTER SET ${charset} COLLATE ${collation} NOT NULL`
  ).join(', ');
  return `ALTER TABLE \`${PROFILE_GROUPS_TABLE}\` ${modify}, ALGORITHM=COPY, LOCK=SHARED`;
}

function isLockWaitTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  return errno === ER_LOCK_WAIT_TIMEOUT || code === 'ER_LOCK_WAIT_TIMEOUT';
}

/**
 * Moves profile_groups' id columns to the schema default collation
 * (`convert`) or back to utf8mb3_bin (`revert`). Returns 0 when the table is
 * already in the requested state, 1 after a verified change.
 */
export async function applyProfileGroupsCollationSchema(
  direction: ProfileGroupsCollationDirection = 'convert',
  source: DataSource = getDataSource(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<number> {
  const desired: ColumnState = direction === 'convert' ? 'target' : 'legacy';
  const runner = source.createQueryRunner('master');
  let priorLockWaitTimeout: number | undefined;
  try {
    if (!(await runner.hasTable(PROFILE_GROUPS_TABLE))) {
      throw new Error(
        'profile_groups collation change requires an existing table'
      );
    }
    if ((await readColumnState(runner)) === desired) return 0;
    const indexesBefore = await readIndexes(runner);
    const duplicates = await duplicateKeysUnder(runner, desired);
    if (duplicates > 0) {
      throw new Error(
        `profile_groups has ${duplicates} keys that collide under the target collation`
      );
    }
    const [settings]: { lock_wait_timeout: number | string }[] =
      await runner.query(
        'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout'
      );
    const timeout = Number(settings.lock_wait_timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 31536000) {
      throw new Error('Invalid session metadata lock timeout');
    }
    priorLockWaitTimeout = timeout;
    await runner.query(
      `SET SESSION lock_wait_timeout = ${LOCK_WAIT_TIMEOUT_SECONDS}`
    );
    const statement = alterStatement(desired);
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        await runner.query(statement);
        logger.info(
          `[PROFILE_GROUPS_COLLATION] ${JSON.stringify({ direction, attempt, alter_ms: Date.now() - started })}`
        );
        break;
      } catch (error) {
        if (!isLockWaitTimeout(error) || attempt >= MAX_ATTEMPTS) throw error;
        logger.warn(
          `[PROFILE_GROUPS_COLLATION] ${JSON.stringify({ direction, attempt, outcome: 'lock_wait_timeout' })}`
        );
        await sleep(2_000 * 2 ** (attempt - 1));
      }
    }
    if ((await readColumnState(runner)) !== desired) {
      throw new Error('profile_groups collation change was not applied');
    }
    if ((await readIndexes(runner)) !== indexesBefore) {
      throw new Error(
        'profile_groups indexes changed during the collation change'
      );
    }
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
