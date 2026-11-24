import { stableUuid } from '@/competitions/competition-id';
import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import { dbSupplier } from '@/sql-executor';

const logger = Logger.get('WAVES_REBUILD_MODERATION_HOLDS');

/** 6529.io's moderation holds on chain entries (the chain mirror's). */
export const HOLDS_TABLE = 'chain_entry_holds';

/**
 * Made-up holds the seed writes, with the mirror's own reasons: a
 * moderation refusal kept for good and a moderation delay waiting to be
 * tried again (the two a rebuild's gate reads as refused and deferred).
 * Every column is given, so the check can compare each value.
 */
export const SEEDED_HOLDS: readonly Readonly<
  Record<string, string | number | null>
>[] = [
  {
    entry_id: `0x${'e1'.repeat(32)}`,
    competition_id: '00000000-0000-4000-8000-0000000000c1',
    reason: 'moderation',
    retry_at: null,
    attempts: 1,
    held_at: 1_764_000_100_000
  },
  {
    entry_id: `0x${'e2'.repeat(32)}`,
    competition_id: '00000000-0000-4000-8000-0000000000c1',
    reason: 'moderation_deferred',
    retry_at: 1_764_000_900_000,
    attempts: 2,
    held_at: 1_764_000_200_000
  }
];

/**
 * The UUIDv5 namespace the chain mirror derives a chain-made wave's rows
 * in (its ids). The check fails if the mirror's description drop id of
 * the held wave is not the one derived here.
 */
const NS_CHAIN_WAVE = 'ba8242d8-b337-49b0-89dd-43bb550868a7';

/** The description drop id of a wave made on the chain, as the mirror's. */
export function descriptionDropIdOf(chainWaveId: string): string {
  return stableUuid(NS_CHAIN_WAVE, `description:${chainWaveId.toLowerCase()}`);
}

/**
 * A refusal of a chain-made wave's description, as the mirror keeps it:
 * keyed by the description drop id, with no competition.
 */
export function descriptionHoldRow(
  chainWaveId: string
): Readonly<Record<string, string | number | null>> {
  return {
    entry_id: descriptionDropIdOf(chainWaveId),
    competition_id: '',
    reason: 'description_moderation',
    retry_at: null,
    attempts: 1,
    held_at: 1_764_000_300_000
  };
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await dbSupplier().execute<{ n: number | string }>(
    `select count(*) as n from information_schema.tables
      where table_schema = database() and table_name = :table`,
    { table }
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * The world's chain-made waves that name a document, in id order: the
 * first gets the refused description, the second is the control.
 */
async function describedWaves(): Promise<{
  held: string;
  control: string;
} | null> {
  if (!(await tableExists('chain_waves'))) return null;
  const rows = await dbSupplier().execute<{ wave_id: string }>(
    `select wave_id from chain_waves
      where origin = 'native'
        and json_type(json_extract(data, '$.metadataCid')) = 'STRING'
      order by wave_id`
  );
  const waves = rows.map((row) => String(row.wave_id));
  return waves.length >= 2 ? { held: waves[0], control: waves[1] } : null;
}

/** Every hold the seed writes: the made-up ones and the description's. */
async function seededHolds(): Promise<
  Readonly<Record<string, string | number | null>>[]
> {
  const waves = await describedWaves();
  return [...SEEDED_HOLDS, ...(waves ? [descriptionHoldRow(waves.held)] : [])];
}

/** Every row and every column, each value as text, in one fixed order. */
export async function dumpHolds(): Promise<string[]> {
  const rows = await dbSupplier().execute<Record<string, unknown>>(
    `select * from ${HOLDS_TABLE}`
  );
  return rows.map((row) => canonicalRow(row)).sort();
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

const NO_DESCRIPTION_HOLD =
  '[NO DESCRIPTION HOLD] the world has fewer than two chain-made waves with a document';

/**
 * Seed: the holds a live mirror would have made, after the chain index's
 * seed (the description refusal goes on one of its chain-made waves).
 * Only where the mirror's table exists (its code is in the tree);
 * otherwise nothing to hold.
 */
export async function seedWavesModerationHolds(
  _ctx: RebuildContext
): Promise<void> {
  if (!(await tableExists(HOLDS_TABLE))) {
    logger.info(`[NO ${HOLDS_TABLE}] the mirror's code is not here`);
    return;
  }
  const holds = await seededHolds();
  if (holds.length === SEEDED_HOLDS.length) logger.warn(NO_DESCRIPTION_HOLD);
  for (const row of holds) {
    const columns = Object.keys(row);
    await dbSupplier().execute(
      `insert into ${HOLDS_TABLE} (${columns.map((c) => `\`${c}\``).join(', ')})
       values (${columns.map((c) => `:${c}`).join(', ')})`,
      row
    );
  }
}

/** Whether the mirror ran in this rebuild: its state row is there. */
async function mirrorRan(): Promise<boolean> {
  if (!(await tableExists('waves_chain_mirror_state'))) return false;
  const rows = await dbSupplier().execute<{ n: number | string }>(
    `select count(*) as n from waves_chain_mirror_state`
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** A chain-made wave's description drop id, and its parts with content. */
async function description(
  chainWaveId: string
): Promise<{ dropId: string; withContent: number } | null> {
  const wave = await dbSupplier().oneOrNull<{ description_drop_id: string }>(
    `select description_drop_id from waves where id = :id`,
    { id: chainWaveId }
  );
  if (!wave) return null;
  const rows = await dbSupplier().execute<{ n: number | string }>(
    `select count(*) as n from drops_parts
      where drop_id = :dropId and coalesce(content, '') <> ''`,
    { dropId: wave.description_drop_id }
  );
  return {
    dropId: String(wave.description_drop_id),
    withContent: Number(rows[0]?.n ?? 0)
  };
}

/**
 * After the mirror: the refused description stayed out, and the control's
 * came in, so the held one's absence is the hold's doing.
 */
async function checkDescriptionHold(): Promise<void> {
  const waves = await describedWaves();
  if (!waves) {
    logger.warn(NO_DESCRIPTION_HOLD);
    return;
  }
  if (!(await mirrorRan())) {
    logger.info(`[DESCRIPTION HOLD NOT TRIED] the mirror did not run`);
    return;
  }
  const expectedDrop = descriptionDropIdOf(waves.held);
  const held = await description(waves.held);
  if (!held) {
    throw new Error(
      `The mirror did not write the held wave ${waves.held}, so its description hold was not tried`
    );
  }
  if (held.dropId !== expectedDrop) {
    throw new Error(
      `The held wave's description drop is ${held.dropId}, not the hold's ${expectedDrop}`
    );
  }
  if (held.withContent) {
    throw new Error(
      `The rebuild released a refused description: wave ${waves.held} shows ${held.withContent} part(s) with content`
    );
  }
  const control = await description(waves.control);
  if (!control?.withContent) {
    throw new Error(
      `The control wave ${waves.control} shows no description content, so the held one's absence proves nothing`
    );
  }
  logger.info(
    `[DESCRIPTION HOLD KEPT] wave ${waves.held} shows no description; the control ${waves.control} shows ${control.withContent} part(s)`
  );
}

/**
 * After every rebuilder that could touch it: the exempt holds are exactly
 * what the seed wrote, row for row and value for value (a rebuild must
 * never release, delete or change a hold), and a refused description
 * stays out of 6529.io's rows.
 */
export async function checkWavesModerationHolds(
  _ctx: RebuildContext
): Promise<void> {
  if (!(await tableExists(HOLDS_TABLE))) {
    logger.info(`[NO ${HOLDS_TABLE}] the mirror's code is not here`);
    return;
  }
  const actual = await dumpHolds();
  const expected = (await seededHolds()).map((row) => canonicalRow(row)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${HOLDS_TABLE} changed in the rebuild: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    );
  }
  logger.info(`[${HOLDS_TABLE} UNCHANGED] ${actual.length} holds`);
  await checkDescriptionHold();
}
