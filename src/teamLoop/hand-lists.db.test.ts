import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MEME_LAB_ROYALTIES_TABLE,
  MEMES_PREVOTE_ARTIST_PROFILES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  loadHandListFiles,
  loadMemeLabSplits,
  loadPrevoteArtists,
  MEME_LAB_SPLITS_FILE,
  parseMemeLabSplits,
  parsePrevoteArtists,
  PREVOTE_ARTISTS_FILE
} from './hand-lists';

function filesDir(splits: string, artists: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hand-lists-'));
  writeFileSync(join(dir, MEME_LAB_SPLITS_FILE), splits);
  writeFileSync(join(dir, PREVOTE_ARTISTS_FILE), artists);
  return dir;
}

describeWithSeed(
  'hand list loaders on MySQL',
  [
    {
      table: MEMES_PREVOTE_ARTIST_PROFILES_TABLE,
      rows: [
        { card_no: 1, profile_id: 'profile-old' },
        { card_no: 2, profile_id: 'profile-1' }
      ]
    }
  ],
  () => {
    it('makes the splits table hold the file, creating it when missing', async () => {
      await sqlExecutor.execute(
        `drop table if exists ${MEME_LAB_ROYALTIES_TABLE}`
      );
      await loadMemeLabSplits(
        parseMemeLabSplits(
          'splits.csv',
          'token_id,primary_royalty_split,secondary_royalty_split\n1,0.5,0.5\n2,0.25,0.1\n'
        )
      );
      // Rows added by hand, outside the file: one at 0 and 0, one with splits.
      await sqlExecutor.execute(
        `insert into ${MEME_LAB_ROYALTIES_TABLE} values (3, 0, 0), (4, 0.9, 0.9)`
      );
      await loadMemeLabSplits(
        parseMemeLabSplits(
          'splits.csv',
          'token_id,primary_royalty_split,secondary_royalty_split\n1,0.5,0.4\n2,0.25,0.1\n'
        )
      );
      expect(
        await sqlExecutor.execute(
          `select token_id, primary_royalty_split, secondary_royalty_split
           from ${MEME_LAB_ROYALTIES_TABLE} order by token_id`
        )
      ).toEqual([
        {
          token_id: 1,
          primary_royalty_split: 0.5,
          secondary_royalty_split: 0.4
        },
        {
          token_id: 2,
          primary_royalty_split: 0.25,
          secondary_royalty_split: 0.1
        },
        { token_id: 3, primary_royalty_split: 0, secondary_royalty_split: 0 },
        { token_id: 4, primary_royalty_split: 0, secondary_royalty_split: 0 }
      ]);
      await sqlExecutor.execute(`drop table ${MEME_LAB_ROYALTIES_TABLE}`);
    });

    it('makes the pre-vote badges table hold exactly the file', async () => {
      await loadPrevoteArtists(
        parsePrevoteArtists(
          'artists.csv',
          'card_no,profile_id\n2,profile-1\n3,profile-2\n'
        )
      );
      expect(
        await sqlExecutor.execute(
          `select card_no, profile_id from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}
           order by card_no`
        )
      ).toEqual([
        { card_no: 2, profile_id: 'profile-1' },
        { card_no: 3, profile_id: 'profile-2' }
      ]);
    });

    it('loads both files, and checks both before changing either table', async () => {
      await sqlExecutor.execute(
        `drop table if exists ${MEME_LAB_ROYALTIES_TABLE}`
      );
      const splits =
        'token_id,primary_royalty_split,secondary_royalty_split\n7,0.5,0.5\n';
      const bad = filesDir(splits, 'card_no,profile_id\n');
      try {
        await expect(loadHandListFiles(bad)).rejects.toThrow('no rows');
      } finally {
        rmSync(bad, { recursive: true, force: true });
      }
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from information_schema.tables
           where table_schema = database() and table_name = :table`,
          { table: MEME_LAB_ROYALTIES_TABLE }
        )
      ).toEqual([{ n: 0 }]);
      const good = filesDir(splits, 'card_no,profile_id\n9,profile-9\n');
      try {
        await expect(loadHandListFiles(good)).resolves.toEqual({
          splits: 1,
          artists: 1
        });
      } finally {
        rmSync(good, { recursive: true, force: true });
      }
      expect(
        await sqlExecutor.execute(
          `select card_no, profile_id from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}`
        )
      ).toEqual([{ card_no: 9, profile_id: 'profile-9' }]);
      await sqlExecutor.execute(`drop table ${MEME_LAB_ROYALTIES_TABLE}`);
    });

    it('changes nothing when given no rows', async () => {
      await expect(loadPrevoteArtists([])).rejects.toThrow('No pre-vote');
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}`
        )
      ).toEqual([{ n: 2 }]);
    });
  }
);
