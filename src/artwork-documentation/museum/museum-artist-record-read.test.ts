import { ArtworkDocumentationDb } from '../artwork-documentation.db';
import { ArtworkDocumentationService } from '../artwork-documentation.service';
import { ContextAccess } from '../artwork-documentation.types';
import { artistCapabilities } from '../artwork-documentation.access';
import { dossierFixture } from './export/dossier-fixture';

function fixture() {
  const context = dossierFixture().snapshot.context;
  const db = Object.create(
    ArtworkDocumentationDb.prototype
  ) as ArtworkDocumentationDb;
  db.one = jest.fn().mockResolvedValue({
    id: 'revision',
    record_version: 7,
    answers_json:
      '{"credit":{"status":"provided","value":"An artist","intended_visibility":"public_record"}}'
  });
  const core = new ArtworkDocumentationService(db);
  const access: ContextAccess = {
    context,
    isArtist: true,
    actorProfileId: context.owner_profile_id,
    capabilities: artistCapabilities()
  };
  jest.spyOn(core, 'authorizeContext').mockResolvedValue(access);
  return { context, db, core, access };
}

afterEach(() => jest.restoreAllMocks());

it('loads the exact requested identity revision only within its authenticated artist owner', async () => {
  const { context, db, core } = fixture();
  const result = await core.artistRecordForContext(context.id, 'revision', {});
  expect(db.one).toHaveBeenCalledWith(
    expect.stringContaining('id=:revisionId AND owner_profile_id=:owner'),
    { revisionId: 'revision', owner: context.owner_profile_id },
    {}
  );
  expect(result).toMatchObject({
    id: 'revision',
    record_version: 7,
    deferred: false,
    answers: { credit: { value: 'An artist' } }
  });
});

it('does not expose shared identity writing to a work reviewer or a missing revision', async () => {
  const { context, db, core, access } = fixture();
  access.isArtist = false;
  await expect(
    core.artistRecordForContext(context.id, 'revision', {})
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(db.one).not.toHaveBeenCalled();
  access.isArtist = true;
  jest.mocked(db.one).mockResolvedValue(null);
  await expect(
    core.artistRecordForContext(context.id, 'another-artists-revision', {})
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});

it.each([1, 3])(
  'keeps identity version numbers numeric in a v%s context response',
  async (version) => {
    const { context, db, core } = fixture();
    context.profile.version = version;
    context.latest_revision_id = null;
    db.query = jest.fn().mockResolvedValue([]);
    jest.mocked(db.one).mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT id,record_version')) {
        expect(sql.includes('answers_json')).toBe(version !== 3);
        return {
          id: 'revision',
          record_version: '7',
          ...(version === 3
            ? {}
            : {
                answers_json:
                  '{"credit":{"status":"provided","value":"An artist","intended_visibility":"public_record"}}'
              })
        } as never;
      }
      return { record_version: '9', latest_revision_id: 'revision' } as never;
    });
    const result = await core.getContext(context.id, {});
    expect(result.artist_record_version).toBe(9);
    expect(result.available_artist_record).toMatchObject({
      id: 'revision',
      record_version: 7,
      answers: version === 3 ? {} : { credit: { value: 'An artist' } },
      ...(version === 3 ? { deferred: true } : {})
    });
    if (version === 3)
      expect(result.available_artist_record?.answers).toEqual({});
  }
);
