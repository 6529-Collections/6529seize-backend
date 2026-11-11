import { ProfilesDb } from './profiles.db';

describe('ProfilesDb.migrateProfileIdsInMemesPrevoteArtistProfiles', () => {
  const connection = { connection: 'tx' } as any;

  function createDb() {
    const execute = jest.fn(
      async (..._args: unknown[]): Promise<unknown[]> => []
    );
    return { db: new ProfilesDb(() => ({ execute }) as any), execute };
  }

  it('drops the cards the target already has before moving the rest', async () => {
    const { db, execute } = createDb();

    await db.migrateProfileIdsInMemesPrevoteArtistProfiles(
      'source',
      'target',
      connection
    );

    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(
        /^delete source_card from memes_prevote_artist_profiles source_card\s+join memes_prevote_artist_profiles target_card\s+on target_card.profile_id = :target and target_card.card_no = source_card.card_no\s+where source_card.profile_id = :profileToBeMerged$/
      ),
      'update memes_prevote_artist_profiles set profile_id = :target where profile_id = :profileToBeMerged'
    ]);
    for (const [, params, opts] of execute.mock.calls) {
      expect(params).toEqual({
        profileToBeMerged: 'source',
        target: 'target'
      });
      expect(opts).toEqual({ wrappedConnection: connection });
    }
  });

  it('does nothing when source and target are the same profile', async () => {
    const { db, execute } = createDb();

    await db.migrateProfileIdsInMemesPrevoteArtistProfiles(
      'same',
      'same',
      connection
    );

    expect(execute).not.toHaveBeenCalled();
  });
});
