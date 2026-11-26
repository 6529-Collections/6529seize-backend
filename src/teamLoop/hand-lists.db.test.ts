import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MEMES_PREVOTE_ARTIST_PROFILES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  loadHandListFiles,
  loadPrevoteArtists,
  parsePrevoteArtists,
  PREVOTE_ARTISTS_FILE
} from './hand-lists';

function filesDir(artists: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hand-lists-'));
  writeFileSync(join(dir, PREVOTE_ARTISTS_FILE), artists);
  return dir;
}

const badges = () =>
  sqlExecutor.execute(
    `select card_no, profile_id from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}
     order by card_no, profile_id`
  );

describeWithSeed(
  'the pre-vote badges loader on MySQL',
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
    it('makes the table hold exactly the file', async () => {
      await loadPrevoteArtists(
        parsePrevoteArtists(
          'artists.csv',
          'card_no,profile_id\n2,profile-1\n3,profile-2\n'
        )
      );
      expect(await badges()).toEqual([
        { card_no: 2, profile_id: 'profile-1' },
        { card_no: 3, profile_id: 'profile-2' }
      ]);
    });

    it('loads the file from a folder, and changes nothing when it has no rows', async () => {
      const empty = filesDir('card_no,profile_id\n');
      try {
        await expect(loadHandListFiles(empty)).rejects.toThrow('no rows');
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
      expect(await badges()).toHaveLength(2);
      const good = filesDir('card_no,profile_id\n9,profile-9\n');
      try {
        await expect(loadHandListFiles(good)).resolves.toEqual({ artists: 1 });
      } finally {
        rmSync(good, { recursive: true, force: true });
      }
      expect(await badges()).toEqual([{ card_no: 9, profile_id: 'profile-9' }]);
    });

    it('refuses an empty list', async () => {
      await expect(loadPrevoteArtists([])).rejects.toThrow('No pre-vote');
      expect(await badges()).toHaveLength(2);
    });
  }
);
