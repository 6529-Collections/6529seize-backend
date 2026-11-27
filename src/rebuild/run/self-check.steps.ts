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

/**
 * Restores the rows without their created_at, which a column owner sets:
 * the column takes its default until then.
 */
async function insertTeamUndated(): Promise<void> {
  for (const row of ROWS) {
    await dbSupplier().execute(
      `INSERT INTO ${TEAM_TABLE} (wallet, collection, name)
       VALUES (:wallet, :collection, :name)`,
      row
    );
  }
}

/** The MEMES rows without their created_at: one partition's row writer. */
export async function rebuildMemesTeamUndated(): Promise<void> {
  for (const row of ROWS.filter((r) => r.collection === 'MEMES')) {
    await dbSupplier().execute(
      `INSERT INTO ${TEAM_TABLE} (wallet, collection, name)
       VALUES (:wallet, :collection, :name)`,
      row
    );
  }
}

/** A row writer that also updates created_at, which an owner owns. */
export async function rebuildTeamThenDate(): Promise<void> {
  await insertTeamUndated();
  await dbSupplier().execute(
    `UPDATE ${TEAM_TABLE} SET created_at = :created_at`,
    { created_at: CREATED_AT }
  );
}

/** Restores team, then writes a table its writes don't name. */
export async function rebuildTeamAndWriteUndeclared(): Promise<void> {
  await insertTeam(false);
  await dbSupplier().execute(
    `INSERT INTO ${MEMES_SEASONS_TABLE}
       (id, created_at, start_index, end_index, count, name, display, boost)
     VALUES (99, :created_at, 1, 2, 2, 'X', 'X', 0)`,
    { created_at: CREATED_AT }
  );
}

/** name's owner: names every row, as the seed does. */
export async function nameTeam(): Promise<void> {
  for (const row of ROWS) {
    await dbSupplier().execute(
      `UPDATE ${TEAM_TABLE} SET name = :name WHERE wallet = :wallet`,
      row
    );
  }
}

/** An owner of name that names only the MEMES rows. */
export async function nameMemesTeam(): Promise<void> {
  for (const row of ROWS.filter((r) => r.collection === 'MEMES')) {
    await dbSupplier().execute(
      `UPDATE ${TEAM_TABLE} SET name = :name WHERE wallet = :wallet`,
      row
    );
  }
}

/** A row writer that leaves created_at to its owner. */
export async function rebuildTeamUndated(): Promise<void> {
  await insertTeamUndated();
}

/** The same, deleting every row first, as a writer that starts over does. */
export async function rebuildTeamUndatedAfterDelete(): Promise<void> {
  await dbSupplier().execute(`DELETE FROM ${TEAM_TABLE}`);
  await insertTeamUndated();
}

/** created_at's owner: dates every row. */
export async function dateTeam(): Promise<void> {
  await dbSupplier().execute(
    `UPDATE ${TEAM_TABLE} SET created_at = :created_at`,
    { created_at: CREATED_AT }
  );
}

/** An owner that dates only the MEMES rows. */
export async function dateMemesTeam(): Promise<void> {
  await dbSupplier().execute(
    `UPDATE ${TEAM_TABLE} SET created_at = :created_at WHERE collection = 'MEMES'`,
    { created_at: CREATED_AT }
  );
}

/** An owner that also adds a row. */
export async function dateTeamAndAddRow(): Promise<void> {
  await dateTeam();
  await dbSupplier().execute(
    `INSERT INTO ${TEAM_TABLE} (wallet, collection, name, created_at)
     VALUES ('0x0000000000000000000000000000000000000009', 'MEMES', 'Extra', :created_at)`,
    { created_at: CREATED_AT }
  );
}

/** An owner that also renames rows: a column it doesn't own. */
export async function dateTeamAndRename(): Promise<void> {
  await dateTeam();
  await dbSupplier().execute(
    `UPDATE ${TEAM_TABLE} SET name = CONCAT(name, ' renamed')`
  );
}

/** Restores the MEMES rows, and renames another partition's row. */
export async function rebuildMemesTeamTouchingOthers(): Promise<void> {
  await insertTeam(false, 'MEMES');
  await dbSupplier().execute(
    `UPDATE ${TEAM_TABLE} SET name = 'changed' WHERE collection = '6529'`
  );
}

/** Restores the MEMES rows, and deletes another partition's row. */
export async function rebuildMemesTeamDeletingOthers(): Promise<void> {
  await insertTeam(false, 'MEMES');
  await dbSupplier().execute(
    `DELETE FROM ${TEAM_TABLE} WHERE collection = '6529'`
  );
}

/** Restores the rows with different names. */
export async function rebuildTeamDifferently(): Promise<void> {
  await insertTeam(true);
}

/** The MEMES rows renamed: one partition's writer. */
export async function rebuildMemesTeamRenamed(): Promise<void> {
  await insertTeam(true, 'MEMES');
}

/** Writes nothing: a partition writer whose rows a later change brings. */
export async function writeNothing(): Promise<void> {
  // Its rows are planned.
}

/**
 * Restores the MEMES rows, and the 6529 row renamed and without its
 * created_at: changed in a planned column and in another.
 */
export async function rebuildTeamRenaming6529Undated(): Promise<void> {
  await insertTeam(false, 'MEMES');
  const row = ROWS.find((r) => r.collection === '6529')!;
  await dbSupplier().execute(
    `INSERT INTO ${TEAM_TABLE} (wallet, collection, name)
     VALUES (:wallet, :collection, :name)`,
    { ...row, name: `${row.name} renamed` }
  );
}

/** Restores the MEMES rows, and the 6529 row with another name. */
export async function rebuildTeamRenaming6529(): Promise<void> {
  await insertTeam(false, 'MEMES');
  await insertTeam(true, '6529');
}

/**
 * Reads the 6529 row, which the table's rebuilder doesn't write: a later
 * step that needs rows a keep plan keeps. Fails when it isn't there.
 */
export async function readKeptTeamRow(): Promise<void> {
  const [row] = await dbSupplier().execute<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM ${TEAM_TABLE} WHERE collection = '6529'`
  );
  if (Number(row?.n) !== 1) {
    throw new Error("The 6529 team row isn't there for its reader");
  }
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

/** The seasons without created_at, left to its owner. */
export async function rebuildSeasonsUndated(): Promise<void> {
  for (const season of SEASONS) {
    await dbSupplier().execute(
      `INSERT INTO ${MEMES_SEASONS_TABLE}
         (id, start_index, end_index, count, name, display, boost)
       VALUES (:id, :start_index, :end_index, :count, :name, :name, :boost)`,
      season
    );
  }
}

/** created_at's owner for the seasons. */
export async function dateSeasons(): Promise<void> {
  await dbSupplier().execute(
    `UPDATE ${MEMES_SEASONS_TABLE} SET created_at = :created_at`,
    { created_at: CREATED_AT }
  );
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
