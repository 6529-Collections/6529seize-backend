import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import { dbSupplier } from '@/sql-executor';

const logger = Logger.get('WAVES_REBUILD_MODERATION_HOLDS');

/** 6529.io's moderation holds on chain entries (the chain mirror's). */
export const HOLDS_TABLE = 'chain_entry_holds';

/**
 * Made-up holds the seed writes: a refusal kept for good and a delay
 * waiting to be tried again. Every column is given, so the check can
 * compare each value.
 */
export const SEEDED_HOLDS: readonly Readonly<
  Record<string, string | number | null>
>[] = [
  {
    entry_id: `0x${'e1'.repeat(32)}`,
    competition_id: '00000000-0000-4000-8000-0000000000c1',
    reason: 'moderation_refused',
    retry_at: null,
    attempts: 0,
    held_at: 1_764_000_100_000
  },
  {
    entry_id: `0x${'e2'.repeat(32)}`,
    competition_id: '00000000-0000-4000-8000-0000000000c1',
    reason: 'manifest_not_in_store',
    retry_at: 1_764_000_900_000,
    attempts: 2,
    held_at: 1_764_000_200_000
  }
];

async function tableExists(): Promise<boolean> {
  const rows = await dbSupplier().execute<{ n: number | string }>(
    `select count(*) as n from information_schema.tables
      where table_schema = database() and table_name = :table`,
    { table: HOLDS_TABLE }
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Every row and every column, in key order, each value as text. */
export async function dumpHolds(): Promise<string[]> {
  const rows = await dbSupplier().execute<Record<string, unknown>>(
    `select * from ${HOLDS_TABLE} order by entry_id`
  );
  return rows.map((row) => canonicalRow(row));
}

export function canonicalRow(row: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort((a, b) => a.localeCompare(b))
      .map((column) => [
        column,
        row[column] === null || row[column] === undefined
          ? null
          : String(row[column])
      ])
  );
}

/**
 * Seed: the holds a live mirror would have made. Only where the mirror's
 * table exists (its code is in the tree); otherwise nothing to hold.
 */
export async function seedWavesModerationHolds(
  _ctx: RebuildContext
): Promise<void> {
  if (!(await tableExists())) {
    logger.info(`[NO ${HOLDS_TABLE}] the mirror's code is not here`);
    return;
  }
  for (const row of SEEDED_HOLDS) {
    const columns = Object.keys(row);
    await dbSupplier().execute(
      `insert into ${HOLDS_TABLE} (${columns.map((c) => `\`${c}\``).join(', ')})
       values (${columns.map((c) => `:${c}`).join(', ')})`,
      row
    );
  }
}

/**
 * After every rebuilder that could touch it: the exempt holds are exactly
 * what the seed wrote, row for row and value for value. A rebuild must
 * never release (delete) or change a hold.
 */
export async function checkWavesModerationHolds(
  _ctx: RebuildContext
): Promise<void> {
  if (!(await tableExists())) {
    logger.info(`[NO ${HOLDS_TABLE}] the mirror's code is not here`);
    return;
  }
  const actual = await dumpHolds();
  const expected = SEEDED_HOLDS.map((row) => canonicalRow(row));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${HOLDS_TABLE} changed in the rebuild: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    );
  }
  logger.info(`[${HOLDS_TABLE} UNCHANGED] ${actual.length} holds`);
}
