import { RequestContext } from '@/request.context';
import { artistCapabilities } from './artwork-documentation.access';
import {
  writeAssetLink,
  AssetLinkInput
} from './artwork-documentation.asset-links';
import { artworkDocumentationService as core } from './artwork-documentation.service';
import { ContextAccess } from './artwork-documentation.types';
import { artworkAssetsService as assets } from './assets/artwork-assets.service';
import { dossierFixture } from './museum/export/dossier-fixture';
import { randomUUID } from 'node:crypto';
import { documentationContextBytes } from './museum/museum-response-budget';

function setup() {
  const { snapshot } = dossierFixture();
  const context = snapshot.context;
  context.asset_links = [];
  const access: ContextAccess = {
    context,
    actorProfileId: 'test-editor',
    isArtist: false,
    capabilities: { ...artistCapabilities(), read_rights_evidence: false }
  };
  const transaction: { connection?: RequestContext['connection'] } = {
    connection: { connection: {} }
  };
  jest
    .spyOn(core, 'mutate')
    .mockImplementation(async (_id, _mutation, _ctx, run) =>
      run(access, transaction)
    );
  jest.spyOn(core, 'getContext').mockResolvedValue({} as never);
  const ready = jest.spyOn(assets, 'validateReadyAsset').mockResolvedValue({
    ...snapshot.assets[0],
    has_preview: false
  });
  const disclose = jest.spyOn(assets, 'updateDisclosure').mockResolvedValue();
  const referenced = jest.spyOn(assets, 'markReferenced').mockResolvedValue();
  const input: AssetLinkInput = {
    asset_id: snapshot.assets[0].id,
    role: 'consent_instrument',
    intended_visibility: 'public_record',
    intended_terms: {
      kind: 'already_licensed',
      license_uri: 'https://creativecommons.org/publicdomain/zero/1.0/'
    },
    label: 'Public consent statement',
    description: '',
    source_of_asset: 'self',
    source_credit: '',
    derived_from_asset_ids: [],
    deposit_note: ''
  };
  const mutation = {
    key: 'test',
    route: '/assets',
    body: input,
    expectedVersion: context.draft_version
  };
  return {
    context,
    access,
    transaction,
    ready,
    disclose,
    referenced,
    input,
    mutation
  };
}

afterEach(() => jest.restoreAllMocks());

it.each(['consent_instrument', 'rights_instrument'])(
  'links a v3 public %s without adding restricted paths or an artist confirmation',
  async (role) => {
    const f = setup();
    const version = f.context.draft_version;
    const confirmation = f.context.latest_revision_id;
    await writeAssetLink(f.context.id, { ...f.input, role }, f.mutation, {});
    expect(f.context.asset_links).toHaveLength(1);
    expect(f.context.asset_links[0]).toMatchObject({
      role,
      intended_visibility: 'public_record'
    });
    expect(f.context.restricted_paths).toEqual([]);
    expect(f.disclose).toHaveBeenCalledWith(
      f.context.id,
      f.input.asset_id,
      expect.objectContaining({
        publicationOnlyV3: true,
        canReadRightsEvidence: false
      }),
      { role, intended_visibility: 'public_record' },
      f.transaction.connection
    );
    expect(f.referenced).toHaveBeenCalledTimes(1);
    expect(f.context.draft_version).toBe(version);
    expect(f.context.latest_revision_id).toBe(confirmation);
  }
);

it.each([1, 2])(
  'preserves legacy v%s restricted instrument rules before changing storage',
  async (version) => {
    const f = setup();
    f.context.profile = { ...f.context.profile, version };
    await expect(
      writeAssetLink(f.context.id, f.input, f.mutation, {})
    ).rejects.toMatchObject({ code: 'RESTRICTED_VISIBILITY_REQUIRED' });
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.disclose).not.toHaveBeenCalled();
    expect(f.referenced).not.toHaveBeenCalled();
    expect(f.context.asset_links).toEqual([]);
  }
);

it('rejects new restricted v3 links before storage mutations', async () => {
  const f = setup();
  await expect(
    writeAssetLink(
      f.context.id,
      { ...f.input, intended_visibility: 'restricted' },
      f.mutation,
      {}
    )
  ).rejects.toMatchObject({ code: 'PUBLICATION_VISIBILITY_REQUIRED' });
  expect(f.disclose).not.toHaveBeenCalled();
  expect(f.context.restricted_paths).toEqual([]);
});

it('requires an actual transaction before updating asset disclosure', async () => {
  const f = setup();
  delete f.transaction.connection;
  await expect(
    writeAssetLink(f.context.id, f.input, f.mutation, {})
  ).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
  expect(f.disclose).not.toHaveBeenCalled();
  expect(f.context.asset_links).toEqual([]);
});

it('fits one thousand ordinary links and rejects the next before touching asset storage', async () => {
  const f = setup();
  const template = dossierFixture().snapshot.context.asset_links[0];
  f.context.asset_links = Array.from({ length: 999 }, () => ({
    ...template,
    id: randomUUID(),
    asset_id: randomUUID(),
    derived_from_asset_ids: []
  }));
  await writeAssetLink(f.context.id, f.input, f.mutation, {});
  expect(f.context.asset_links).toHaveLength(1000);
  expect(documentationContextBytes(f.context)).toBeLessThan(
    f.context.profile.limits.context_payload_bytes
  );
  expect(f.ready).toHaveBeenCalledTimes(2);
  await expect(
    writeAssetLink(
      f.context.id,
      { ...f.input, asset_id: randomUUID() },
      f.mutation,
      {}
    )
  ).rejects.toMatchObject({ code: 'ASSET_LINK_LIMIT' });
  expect(f.ready).toHaveBeenCalledTimes(2);
  expect(f.disclose).toHaveBeenCalledTimes(1);
  expect(f.context.asset_links).toHaveLength(1000);
});
