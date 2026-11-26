// Steps for the harness's own end-to-end check (runner.rebuild.test.ts).
// They write the team table, and the memes seasons table for the probe check.
import { MEMES_SEASONS_TABLE, NFTS_TABLE, TEAM_TABLE } from '@/constants';
import { dbSupplier } from '@/sql-executor';

const CREATED_AT = '2026-01-01 00:00:00';

const ROWS = [
  {
    wallet: '0x0000000000000000000000000000000000000001',
    collection: 'MEMES',
    name: 'Fixture one'
  },
  {
    wallet: '0x0000000000000000000000000000000000000002',
    collection: '6529',
    name: 'Fixture two'
  },
  {
    wallet: '0x0000000000000000000000000000000000000003',
    collection: 'MEMES',
    name: 'Fixture three'
  }
];

async function insertTeam(
  rename: boolean,
  collection: string | null = null
): Promise<void> {
  for (const row of ROWS.filter(
    (r) => collection === null || r.collection === collection
  )) {
    await dbSupplier().execute(
      `INSERT INTO ${TEAM_TABLE} (wallet, collection, name, created_at)
       VALUES (:wallet, :collection, :name, :created_at)`,
      {
        ...row,
        name: rename ? `${row.name} renamed` : row.name,
        created_at: CREATED_AT
      }
    );
  }
}

/** The "before" state. */
export async function seedTeam(): Promise<void> {
  await insertTeam(false);
}

/** Restores exactly the seeded rows. */
export async function rebuildTeam(): Promise<void> {
  await insertTeam(false);
}

/** Restores only the MEMES rows: one area's partition of the table. */
export async function rebuildMemesTeam(): Promise<void> {
  await insertTeam(false, 'MEMES');
}

/** Restores the MEMES rows, and renames another partition's row. */
export async function rebuildMemesTeamTouchingOthers(): Promise<void> {
  await insertTeam(false, 'MEMES');
  await dbSupplier().execute(
    `UPDATE ${TEAM_TABLE} SET name = 'changed' WHERE collection = '6529'`
  );
}

/** Restores the rows with different names. */
export async function rebuildTeamDifferently(): Promise<void> {
  await insertTeam(true);
}

/** Reads a table its manifest entry doesn't declare. */
export async function readUndeclaredTable(): Promise<void> {
  await dbSupplier().execute(`SELECT COUNT(*) AS n FROM ${NFTS_TABLE}`);
  await insertTeam(false);
}

/** Calls a host outside the run's sources (RFC 5737 address). */
export async function callOutsideSource(): Promise<void> {
  await fetch('http://192.0.2.1/'); // NOSONAR -- a TEST-NET-1 address (RFC 5737) the source guard must refuse; it is never reached.
  await insertTeam(false);
}

const SEASONS = [
  {
    id: 1,
    start_index: 1,
    end_index: 47,
    count: 47,
    name: 'SZN1',
    boost: 0.05
  },
  {
    id: 2,
    start_index: 48,
    end_index: 86,
    count: 39,
    name: 'SZN2',
    boost: 0.05
  }
];

async function insertSeasons(endShift: number): Promise<void> {
  for (const season of SEASONS) {
    await dbSupplier().execute(
      `INSERT INTO ${MEMES_SEASONS_TABLE}
         (id, created_at, start_index, end_index, count, name, display, boost)
       VALUES
         (:id, :created_at, :start_index, :end_index, :count, :name, :name, :boost)`,
      {
        ...season,
        end_index: season.end_index + endShift,
        created_at: CREATED_AT
      }
    );
  }
}

/** Memes seasons for the probe check: the "before" state. */
export async function seedSeasons(): Promise<void> {
  await insertSeasons(0);
}

/** Restores the seeded seasons. */
export async function rebuildSeasons(): Promise<void> {
  await insertSeasons(0);
}

/** Restores the seasons with other end indexes, so the API answers differ. */
export async function rebuildSeasonsDifferently(): Promise<void> {
  await insertSeasons(1);
}
