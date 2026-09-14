import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { artistCapabilities } from '@/artwork-documentation/artwork-documentation.access';
import {
  emptyModules,
  getProfile
} from '@/artwork-documentation/artwork-documentation.catalogue';
import { ArtworkDocumentationService } from '@/artwork-documentation/artwork-documentation.service';
import {
  AssetGateway,
  ContextAccess
} from '@/artwork-documentation/artwork-documentation.types';
import { fail } from '@/artwork-documentation/artwork-documentation.validation';

function fixture(profileId = 'stream_artwork_basic_v1', version = 2) {
  const assetId = randomUUID();
  const owner = randomUUID();
  const access: ContextAccess = {
    actorProfileId: owner,
    isArtist: true,
    capabilities: artistCapabilities(),
    context: {
      id: randomUUID(),
      work_id: randomUUID(),
      owner_profile_id: owner,
      program_id: null,
      profile: getProfile(profileId, version),
      draft_version: 1,
      artist_record_revision_id: null,
      latest_revision_id: null,
      lifecycle: 'active',
      modules: emptyModules(),
      restricted_paths: [],
      created_at: 1,
      updated_at: 1,
      asset_links: [
        {
          id: randomUUID(),
          asset_id: assetId,
          role: 'artwork_final',
          label: 'Final',
          description: '',
          intended_visibility: 'public_record',
          source_of_asset: 'self',
          source_credit: '',
          derived_from_asset_ids: [],
          deposit_note: '',
          intended_terms: { kind: 'unspecified' },
          manifest: {
            id: assetId,
            role: 'artwork_final',
            intended_visibility: 'public_record',
            state: 'ready'
          }
        }
      ]
    }
  };
  access.context.modules.artwork.canonical_asset_id = {
    status: 'provided',
    value: assetId,
    intended_visibility: 'public_record'
  };
  access.context.modules.files.master_availability = {
    status: 'provided',
    value: { kind: 'same_as_final' },
    intended_visibility: 'public_record'
  };
  const assets: AssetGateway = {
    listAssets: jest.fn(async () => []),
    validateReadyAsset: jest.fn(async () => ({ id: assetId, state: 'ready' })),
    markReferenced: jest.fn(async () => undefined)
  };
  return {
    assetId,
    access,
    assets,
    service: new ArtworkDocumentationService(undefined, assets)
  };
}

describe('canonical final file used as the preservation master', () => {
  it.each([
    ['stream_artwork_basic_v1', 1],
    ['photography_documentation_v1', 2],
    ['keys_and_gates_v1', 2],
    ['stream_artwork_basic_v1', 3]
  ] as const)(
    'validates %s v%i with one ready final link without rewriting the record',
    async (profileId, version) => {
      const { access, assets, service, assetId } = fixture(profileId, version);
      const before = structuredClone(access.context);
      await expect(
        service.validateAssetReferences(access, {}, true)
      ).resolves.toBeUndefined();
      expect(assets.validateReadyAsset).toHaveBeenCalledTimes(1);
      expect(assets.validateReadyAsset).toHaveBeenCalledWith(
        access.context.id,
        assetId,
        expect.any(Object),
        {}
      );
      expect(access.context).toEqual(before);
      expect(assets.markReferenced).not.toHaveBeenCalled();
    }
  );
  it('does not infer the master from a final link when no canonical file was selected', async () => {
    const { access, service } = fixture();
    delete access.context.modules.artwork.canonical_asset_id;
    await expect(
      service.validateAssetReferences(access, {}, true)
    ).rejects.toMatchObject({ code: 'MASTER_ROLE_REQUIRED' });
  });
  it('still requires the selected canonical file to have the final-file role', async () => {
    const { access, service } = fixture();
    access.context.asset_links[0].role = 'preservation_master';
    await expect(
      service.validateAssetReferences(access, {}, true)
    ).rejects.toMatchObject({ code: 'ASSET_ROLE_REQUIRED' });
  });
  it('does not skip the selected file readiness check', async () => {
    const { access, assets, service } = fixture();
    (assets.validateReadyAsset as jest.Mock).mockImplementation(async () =>
      fail(409, 'ASSET_NOT_READY')
    );
    await expect(
      service.validateAssetReferences(access, {}, true)
    ).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
  });
  it.each([
    ['master_availability', 'MASTER_ASSET_REQUIRED'],
    ['source_availability', 'SOURCE_ASSET_REQUIRED']
  ])(
    'still requires a distinct supplied-file role for %s',
    async (field, code) => {
      const { access, service } = fixture(
        'stream_artwork_basic_v1',
        field === 'source_availability' ? 1 : 2
      );
      access.context.modules.files[field] = {
        status: 'provided',
        value: { kind: 'supplied' },
        intended_visibility: 'public_record'
      };
      await expect(
        service.validateAssetReferences(access, {}, true)
      ).rejects.toMatchObject({ code });
    }
  );
});
