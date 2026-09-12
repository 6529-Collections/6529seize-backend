import 'reflect-metadata';
import { ArtworkDocumentationService } from '../artwork-documentation.service';
import { emptyCapabilities } from '../artwork-documentation.access';
import { getProfile } from '../artwork-documentation.catalogue';
import { RequestContext } from '@/request.context';
import { dossierFixture } from './export/dossier-fixture';

describe('Museum publication preview', () => {
  function fixture(version = 3) {
    const { snapshot } = dossierFixture();
    const context = snapshot.context;
    context.profile = getProfile('stream_artwork_basic_v1', version);
    context.asset_links[0].role = 'rights_instrument';
    context.modules.rights.material_rights = {
      status: 'provided',
      intended_visibility: 'public_record',
      value: [
        {
          id: '10000000-0000-4000-8000-000000000030',
          subject_ids: [context.work_id],
          basis: 'license',
          account: 'Publicly documented permission.',
          uses: [],
          instrument_asset_ids: [context.asset_links[0].asset_id]
        }
      ]
    };
    const service = Object.create(
      ArtworkDocumentationService.prototype
    ) as ArtworkDocumentationService;
    const authorizeContext = jest.fn();
    authorizeContext.mockResolvedValue({
      context,
      isArtist: true,
      actorProfileId: context.owner_profile_id,
      capabilities: { ...emptyCapabilities(), read_context: true }
    });
    service.authorizeContext = authorizeContext;
    return { context, service };
  }
  it('shows public rights instruments and their referring article to an authorized v3 preview reader', async () => {
    const { context, service } = fixture();
    const preview = await service.publicPreview(
      context.id,
      {} as RequestContext
    );
    expect(preview.asset_links).toHaveLength(1);
    expect(preview.modules.rights.answers.material_rights).toEqual(
      context.modules.rights.material_rights
    );
    expect(preview.asset_links[0].manifest.sha256).toBeNull();
  });
  it('retains historical evidence restrictions and refuses preview without context authorization', async () => {
    const { context, service } = fixture(2);
    expect(
      (await service.publicPreview(context.id, {} as RequestContext))
        .asset_links
    ).toEqual([]);
    (service.authorizeContext as jest.Mock).mockRejectedValueOnce(
      new Error('UNAVAILABLE')
    );
    await expect(
      service.publicPreview(context.id, {} as RequestContext)
    ).rejects.toThrow('UNAVAILABLE');
  });
  it('does not treat an explicitly restricted file as public in a v3 record', async () => {
    const { context, service } = fixture();
    context.asset_links[0].intended_visibility = 'restricted';
    context.restricted_paths = [`asset:${context.asset_links[0].asset_id}`];
    const preview = await service.publicPreview(
      context.id,
      {} as RequestContext
    );
    expect(preview.asset_links).toEqual([]);
    expect(preview.modules.rights.answers.material_rights).toBeUndefined();
  });
});
