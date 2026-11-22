import { readFileSync } from 'fs';
import {
  MEME_LAB_ROYALTIES_TABLE,
  MEMES_PREVOTE_ARTIST_PROFILES_TABLE
} from '@/constants';
import { SqlExecutor, sqlExecutor } from '@/sql-executor';

/**
 * Two lists the team keeps by hand, loaded from files in this folder so a
 * rebuild has them: Meme Lab royalty splits and the pre-vote artist badges.
 * The team commits the files from a production export. A file with no rows
 * is refused: it would wipe the table.
 */

export const MEME_LAB_SPLITS_FILE = 'meme-lab-royalties.csv';
export const PREVOTE_ARTISTS_FILE = 'prevote-artists.csv';

export const MEME_LAB_SPLITS_HEADER = [
  'token_id',
  'primary_royalty_split',
  'secondary_royalty_split'
];
export const PREVOTE_ARTISTS_HEADER = ['card_no', 'profile_id'];

export interface MemeLabSplit {
  readonly token_id: number;
  readonly primary_royalty_split: number;
  readonly secondary_royalty_split: number;
}

export interface PrevoteArtist {
  readonly card_no: number;
  readonly profile_id: string;
}

export class HandListFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandListFileError';
    // The build targets ES5, where a subclass of Error loses its prototype.
    Object.setPrototypeOf(this, HandListFileError.prototype);
  }
}

/** Rows of a plain CSV: a header line, no quoting, no empty fields. */
function csvRows(
  name: string,
  text: string,
  header: readonly string[]
): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const found = (lines.shift() ?? '').split(',').map((cell) => cell.trim());
  if (found.join(',') !== header.join(',')) {
    throw new HandListFileError(
      `${name}: the first line must be ${header.join(',')}`
    );
  }
  if (!lines.length) {
    throw new HandListFileError(`${name} has no rows; refusing to empty it`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== header.length || cells.some((cell) => !cell)) {
      throw new HandListFileError(
        `${name} line ${index + 2}: expected ${header.length} values`
      );
    }
    return cells;
  });
}

function whole(name: string, line: number, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new HandListFileError(
      `${name} line ${line}: ${value} is not a number`
    );
  }
  return Number(value);
}

function split(name: string, line: number, value: string): number {
  const parsed = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || parsed > 1) {
    throw new HandListFileError(
      `${name} line ${line}: a split is a share from 0 to 1, not ${value}`
    );
  }
  return parsed;
}

function unique<T>(name: string, rows: readonly T[], key: (row: T) => string) {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id))
      throw new HandListFileError(`${name}: ${id} is listed twice`);
    seen.add(id);
  }
}

export function parseMemeLabSplits(name: string, text: string): MemeLabSplit[] {
  const rows = csvRows(name, text, MEME_LAB_SPLITS_HEADER).map(
    (cells, index) => ({
      token_id: whole(name, index + 2, cells[0]),
      primary_royalty_split: split(name, index + 2, cells[1]),
      secondary_royalty_split: split(name, index + 2, cells[2])
    })
  );
  unique(name, rows, (row) => `token ${row.token_id}`);
  return rows;
}

export function parsePrevoteArtists(
  name: string,
  text: string
): PrevoteArtist[] {
  const rows = csvRows(name, text, PREVOTE_ARTISTS_HEADER).map(
    (cells, index) => ({
      card_no: whole(name, index + 2, cells[0]),
      profile_id: cells[1]
    })
  );
  unique(name, rows, (row) => `card ${row.card_no} profile ${row.profile_id}`);
  return rows;
}

/**
 * Makes the splits table hold the file: each listed token gets its splits.
 * Rows exist only for listed tokens or were made by hand; one that is not in
 * the file goes to 0 and 0 (no split) rather than being deleted.
 */
export async function loadMemeLabSplits(
  splits: readonly MemeLabSplit[],
  db: SqlExecutor = sqlExecutor
): Promise<void> {
  if (!splits.length) throw new HandListFileError('No Meme Lab splits');
  // Made by hand in production, so no entity creates it on a fresh database;
  // this leaves an existing table as it is. Outside the transaction: MySQL
  // commits a transaction implicitly on DDL.
  await db.execute(
    `create table if not exists ${MEME_LAB_ROYALTIES_TABLE} (
       token_id int not null primary key,
       primary_royalty_split double not null default 0,
       secondary_royalty_split double not null default 0
     )`
  );
  await db.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await db.execute(
      `update ${MEME_LAB_ROYALTIES_TABLE}
       set primary_royalty_split = 0, secondary_royalty_split = 0
       where token_id not in (:tokens)
         and (primary_royalty_split <> 0 or secondary_royalty_split <> 0)`,
      { tokens: splits.map((row) => row.token_id) },
      options
    );
    for (const row of splits) {
      await db.execute(
        `insert into ${MEME_LAB_ROYALTIES_TABLE}
           (token_id, primary_royalty_split, secondary_royalty_split)
         values (:token_id, :primary_royalty_split, :secondary_royalty_split)
         on duplicate key update
           primary_royalty_split = values(primary_royalty_split),
           secondary_royalty_split = values(secondary_royalty_split)`,
        row,
        options
      );
    }
  });
}

/** Makes the pre-vote badges table hold exactly the file's rows. */
export async function loadPrevoteArtists(
  artists: readonly PrevoteArtist[],
  db: SqlExecutor = sqlExecutor
): Promise<void> {
  if (!artists.length) throw new HandListFileError('No pre-vote artists');
  await db.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await db.execute(
      `delete from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}`,
      undefined,
      options
    );
    for (const row of artists) {
      await db.execute(
        `insert into ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE} (card_no, profile_id)
         values (:card_no, :profile_id)`,
        row,
        options
      );
    }
  });
}

/**
 * Loads both files from a folder, by default this one (the loop's bundle
 * holds them beside team.csv). Both files are read and checked before either
 * table changes.
 * The team loop runs it daily behind MINT_HAND_LISTS; a rebuild runs it as
 * a step, which ignores the step context it is called with.
 */
export async function loadHandListFiles(
  dir: string = __dirname,
  db: SqlExecutor = sqlExecutor
): Promise<{ splits: number; artists: number }> {
  const read = (name: string) => readFileSync(`${dir}/${name}`, 'utf8');
  const splits = parseMemeLabSplits(
    MEME_LAB_SPLITS_FILE,
    read(MEME_LAB_SPLITS_FILE)
  );
  const artists = parsePrevoteArtists(
    PREVOTE_ARTISTS_FILE,
    read(PREVOTE_ARTISTS_FILE)
  );
  await loadMemeLabSplits(splits, db);
  await loadPrevoteArtists(artists, db);
  return { splits: splits.length, artists: artists.length };
}

/** The rebuild step: loads both files; the step context is not needed. */
export async function rebuildHandLists(): Promise<void> {
  await loadHandListFiles();
}
