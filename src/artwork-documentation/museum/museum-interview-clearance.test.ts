import { artistCapabilities } from '../artwork-documentation.access';
import { ArtworkDocumentationDb } from '../artwork-documentation.db';
import { ArtworkDocumentationService } from '../artwork-documentation.service';
import { ContextAccess } from '../artwork-documentation.types';
import { mediaCorpus } from './fixtures/museum-corpus';
import { museumRecordIssues, validateMuseumDraft } from './museum-validation';

it('allows staging an interview draft but refuses artist confirmation until that exact recording is cleared', async () => {
  const { snapshot } = mediaCorpus(['audio']);
  const context = snapshot.context;
  context.asset_links[0].role = 'interview_recording';
  context.asset_links[0].manifest.role = 'interview_recording';
  const before = JSON.stringify(context);
  expect(() => validateMuseumDraft(context)).not.toThrow();
  expect(museumRecordIssues(context)).toContainEqual({
    field: `asset:${snapshot.assets[0].id}`,
    code: 'INTERVIEW_PUBLICATION_PERMISSION_REQUIRED',
    lane: 'rights'
  });
  const insert = jest.fn();
  const core = new ArtworkDocumentationService({
    insert
  } as unknown as ArtworkDocumentationDb);
  const access: ContextAccess = {
    context,
    actorProfileId: context.owner_profile_id,
    isArtist: true,
    capabilities: artistCapabilities()
  };
  jest
    .spyOn(core, 'mutate')
    .mockImplementation(async (_id, _mutation, _ctx, run) => run(access, {}));
  const assetGate = jest
    .spyOn(core, 'validateAssetReferences')
    .mockResolvedValue();
  const body = {
    accepted: true,
    confirmation_copy_version: context.profile.confirmation_copy_version
  };
  await expect(
    core.confirm(
      context.id,
      body,
      {
        key: 'test-confirm',
        route: '/confirm',
        body,
        expectedVersion: context.draft_version
      },
      {}
    )
  ).rejects.toThrow('MUSEUM_RECORD_INCOMPLETE');
  expect(assetGate).toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
  expect(JSON.stringify(context)).toBe(before);
});
