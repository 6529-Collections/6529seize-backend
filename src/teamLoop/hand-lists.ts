import { readFileSync } from 'fs';
import { MEMES_PREVOTE_ARTIST_PROFILES_TABLE } from '@/constants';
import { SqlExecutor, sqlExecutor } from '@/sql-executor';

/**
 * The pre-vote artist badges, a list the team keeps by hand, loaded from a
 * file in this folder so a rebuild has it. The team commits the file from a
 * production export. A file with no rows is refused: it would wipe the
 * table. (The Meme Lab royalty splits are the holdings work's:
 * `rebuildMemeLabRoyalties` from `src/holdings/meme-lab-royalties.json`.)
 */

export const PREVOTE_ARTISTS_FILE = 'prevote-artists.csv';

export const PREVOTE_ARTISTS_HEADER = ['card_no', 'profile_id'];

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
  const seen = new Set<string>();
  for (const row of rows) {
    const id = `card ${row.card_no} profile ${row.profile_id}`;
    if (seen.has(id)) {
      throw new HandListFileError(`${name}: ${id} is listed twice`);
    }
    seen.add(id);
  }
  return rows;
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
 * Loads the file from a folder, by default this one (the loop's bundle holds
 * it beside team.csv), and checks it before the table changes. The team
 * loop runs it daily behind MINT_HAND_LISTS; a rebuild runs it as a step,
 * which ignores the step context it is called with.
 */
export async function loadHandListFiles(
  dir: string = __dirname,
  db: SqlExecutor = sqlExecutor
): Promise<{ artists: number }> {
  const artists = parsePrevoteArtists(
    PREVOTE_ARTISTS_FILE,
    readFileSync(`${dir}/${PREVOTE_ARTISTS_FILE}`, 'utf8')
  );
  await loadPrevoteArtists(artists, db);
  return { artists: artists.length };
}

/** The rebuild step: loads the file; the step context is not needed. */
export async function rebuildHandLists(): Promise<void> {
  await loadHandListFiles();
}
