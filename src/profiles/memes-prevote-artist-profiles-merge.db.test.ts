import 'reflect-metadata';
import { MEMES_PREVOTE_ARTIST_PROFILES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ProfilesDb } from './profiles.db';

describeWithSeed(
  'ProfilesDb.migrateProfileIdsInMemesPrevoteArtistProfiles',
  {
    table: MEMES_PREVOTE_ARTIST_PROFILES_TABLE,
    rows: [
      { profile_id: 'source', card_no: 1 },
      { profile_id: 'source', card_no: 2 },
      { profile_id: 'target', card_no: 2 },
      { profile_id: 'target', card_no: 3 },
      { profile_id: 'other', card_no: 1 }
    ]
  },
  () => {
    const db = new ProfilesDb(() => sqlExecutor);

    async function cards() {
      return sqlExecutor.execute(
        `select profile_id, card_no from ${MEMES_PREVOTE_ARTIST_PROFILES_TABLE}
         order by profile_id, card_no`
      );
    }

    async function migrate(source: string, target: string) {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.migrateProfileIdsInMemesPrevoteArtistProfiles(
          source,
          target,
          connection
        )
      );
    }

    it('keeps one card per number for the target when both profiles have it', async () => {
      await migrate('source', 'target');

      expect(await cards()).toEqual([
        { profile_id: 'other', card_no: 1 },
        { profile_id: 'target', card_no: 1 },
        { profile_id: 'target', card_no: 2 },
        { profile_id: 'target', card_no: 3 }
      ]);
    });

    it('is repeatable and changes nothing for a profile without cards', async () => {
      await migrate('source', 'target');
      const merged = await cards();

      await migrate('source', 'target');
      await migrate('no-handle', 'target');
      await migrate('target', 'target');

      expect(await cards()).toEqual(merged);
    });
  }
);
