import 'reflect-metadata';
import { ARTISTS_TABLE, MEME_LAB_ROYALTIES_TABLE } from '@/constants';
import { connect, disconnect, getDataSource, persistArtists } from '@/db';
import { fetchArtistsNamesMemeLab, fetchArtistsNamesMemes } from '@/db-api';
import * as Entities from '@/entities/entities';
import { fetchMemesMintStatsTotals } from '@/api/memes-mint-stats/api.memes-mint-stats.db';
import { rebuildMemeLabRoyalties } from '@/holdings/meme-lab-royalties-rebuild';
import { createMissingUnsyncedHoldingsTables } from './unsynced-holdings-tables-schema';

jest.mock('@/holdings/meme-lab-royalties.json', () => ({
  '2': { primary_royalty_split: 0.5, secondary_royalty_split: 0.25 },
  '1': { primary_royalty_split: 0.6, secondary_royalty_split: 0.1 }
}));

async function columns(table: string) {
  const rows: {
    COLUMN_NAME: string;
    COLUMN_TYPE: string;
    IS_NULLABLE: string;
    COLUMN_KEY: string;
  }[] = await getDataSource().query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map(
    (c) =>
      `${c.COLUMN_NAME} ${c.COLUMN_TYPE}${c.IS_NULLABLE === 'NO' ? ' not null' : ''}${c.COLUMN_KEY === 'PRI' ? ' key' : ''}`
  );
}

describe('artists and meme_lab_royalties on a fresh schema', () => {
  beforeAll(async () => {
    await connect(
      Object.values(Entities).filter((e) => typeof e === 'function'),
      false
    );
  });

  afterAll(async () => {
    await getDataSource().query(`DELETE FROM ${ARTISTS_TABLE}`);
    await getDataSource().query(`DELETE FROM ${MEME_LAB_ROYALTIES_TABLE}`);
    await disconnect();
  });

  it('creates both tables when missing, as the entities describe them', async () => {
    await getDataSource().query(`DROP TABLE IF EXISTS ${ARTISTS_TABLE}`);
    await getDataSource().query(
      `DROP TABLE IF EXISTS ${MEME_LAB_ROYALTIES_TABLE}`
    );

    await createMissingUnsyncedHoldingsTables(getDataSource());

    expect(await columns(ARTISTS_TABLE)).toEqual([
      'name varchar(255) not null key',
      'created_at datetime',
      'memes text',
      'memelab text',
      'gradients text',
      'bio text',
      'pfp text',
      'work text',
      'social_links text'
    ]);
    expect(await columns(MEME_LAB_ROYALTIES_TABLE)).toEqual([
      'token_id int not null key',
      'primary_royalty_split double not null',
      'secondary_royalty_split double not null'
    ]);
  });

  it('leaves existing tables and their rows as they are', async () => {
    await getDataSource().query(`DROP TABLE IF EXISTS ${ARTISTS_TABLE}`);
    await getDataSource().query(
      `CREATE TABLE ${ARTISTS_TABLE} (name varchar(100) PRIMARY KEY, memes json)`
    );
    await getDataSource().query(
      `INSERT INTO ${ARTISTS_TABLE} (name, memes) VALUES ('Artist', '[]')`
    );

    await createMissingUnsyncedHoldingsTables(getDataSource());

    expect(await columns(ARTISTS_TABLE)).toEqual([
      'name varchar(100) not null key',
      'memes json'
    ]);
    expect(
      await getDataSource().query(`SELECT name FROM ${ARTISTS_TABLE}`)
    ).toEqual([{ name: 'Artist' }]);

    await getDataSource().query(`DROP TABLE ${ARTISTS_TABLE}`);
    await createMissingUnsyncedHoldingsTables(getDataSource());
  });

  it('answers the artist names and the mint stats total from the rows the NFTs loop writes', async () => {
    await getDataSource().query(`DELETE FROM ${ARTISTS_TABLE}`);
    expect((await fetchMemesMintStatsTotals()).artists_count).toBe(0);
    expect(await fetchArtistsNamesMemes()).toEqual([]);

    await persistArtists([
      {
        name: 'Second',
        memes: [{ id: 7, collboration_with: [] }],
        memelab: [],
        gradients: [],
        work: [],
        social_links: []
      },
      {
        name: 'First',
        memes: [
          { id: 4, collboration_with: [] },
          { id: 2, collboration_with: [] }
        ],
        memelab: [{ id: 9, collboration_with: [] }],
        gradients: [3],
        work: [],
        social_links: []
      }
    ]);

    expect(Number((await fetchMemesMintStatsTotals()).artists_count)).toBe(2);
    expect(await fetchArtistsNamesMemes()).toEqual([
      { name: 'First', cards: [2, 4] },
      { name: 'Second', cards: [7] }
    ]);
    expect(await fetchArtistsNamesMemeLab()).toEqual([
      { name: 'First', cards: [9] }
    ]);
  });

  it('rebuilds the Meme Lab royalties from the repository file', async () => {
    await getDataSource().query(
      `INSERT INTO ${MEME_LAB_ROYALTIES_TABLE} VALUES (5, 0.9, 0.9)`
    );

    await rebuildMemeLabRoyalties();

    expect(
      await getDataSource().query(
        `SELECT * FROM ${MEME_LAB_ROYALTIES_TABLE} ORDER BY token_id`
      )
    ).toEqual([
      {
        token_id: 1,
        primary_royalty_split: 0.6,
        secondary_royalty_split: 0.1
      },
      {
        token_id: 2,
        primary_royalty_split: 0.5,
        secondary_royalty_split: 0.25
      }
    ]);
  });
});
