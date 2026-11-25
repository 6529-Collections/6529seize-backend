import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import { ProfileCmsPointerEventType } from '@/entities/IProfileCmsPointerEvent';
import {
  ProfileCmsChainTarget,
  ProfileCmsChainTransitionInput,
  profileCmsChainTransition
} from '@/profile-cms/chain/profile-cms-chain-transition';
import {
  CheckedProfileCmsPublication,
  checkProfileCmsPublication
} from '@/profile-cms/chain/profile-cms-publication-check';
import {
  aSignedProfileSite,
  CHAIN_FIXTURE_PRINCIPAL,
  CHAIN_FIXTURE_PROFILE_ID,
  CHAIN_FIXTURE_WALLET,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';

const T = Date.parse('2026-11-25T02:00:00.000Z');

async function checked(
  site: SignedSiteFixture
): Promise<CheckedProfileCmsPublication> {
  const result = await checkProfileCmsPublication({
    primary: { publication: site.publicationCid, package: site.coreCid },
    publicationBytes: site.publicationBytes,
    packageBytes: site.coreBytes,
    profileId: CHAIN_FIXTURE_PROFILE_ID,
    wallets: [CHAIN_FIXTURE_WALLET.address.toLowerCase()],
    checkedAtMs: T
  });
  if (!result.ok) throw new Error(result.reason);
  return result.checked;
}

function aPublishedRow(
  site: SignedSiteFixture,
  overrides: Partial<ProfileCmsPackageEntity> = {}
): ProfileCmsPackageEntity {
  return {
    id: site.draftId,
    profile_id: CHAIN_FIXTURE_PROFILE_ID,
    profile_handle: 'testhandle',
    package_id: site.cmsPackage.package_id,
    version: 1,
    status: ProfileCmsPackageStatus.PUBLISHED,
    cms_package: site.cmsPackage,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    package_hash: site.packageHash,
    primary_path: '/testhandle/index.html',
    is_primary: true,
    production_valid: true,
    created_by_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    published_by_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    created_at: 1,
    updated_at: 2,
    validated_at: 2,
    published_at: 2,
    failed_at: null,
    archived_at: null,
    superseded_by_id: null,
    validation_result: null,
    validation_error: null,
    storage_receipts: site.cmsPackage.storage,
    storage_provider: 'arweave',
    storage_uri: `ar://${'a'.repeat(43)}`,
    storage_content_hash: site.packageHash,
    storage_provider_content_id: null,
    storage_recorded_at: '2026-11-20T00:00:00.000Z',
    storage_pinned: null,
    storage_canonical: true,
    recovery_receipt: null,
    publication_cid: site.publicationCid,
    ...overrides
  };
}

function transition(
  overrides: Partial<ProfileCmsChainTransitionInput> & {
    target: ProfileCmsChainTarget;
  }
) {
  return profileCmsChainTransition({
    profileId: CHAIN_FIXTURE_PROFILE_ID,
    principal: CHAIN_FIXTURE_PRINCIPAL,
    height: 100,
    timeMs: T,
    version: 2,
    docCid: 'bafkreie5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq',
    currentPrimary: null,
    targetRow: null,
    ...overrides
  });
}

describe('profileCmsChainTransition', () => {
  let first: SignedSiteFixture;
  let second: SignedSiteFixture;

  beforeAll(async () => {
    first = await aSignedProfileSite({ draftId: 'draft-1', version: 1 });
    second = await aSignedProfileSite({
      draftId: 'draft-2',
      version: 2,
      title: 'Second version'
    });
  });

  it('publishes a first site with the publish triple, minus the supersede', async () => {
    const result = transition({
      target: { kind: 'publication', checked: await checked(first) }
    });
    expect(result.refused).toBeNull();
    expect(result.events.map((event) => event.event_type)).toEqual([
      ProfileCmsPointerEventType.PUBLISH,
      ProfileCmsPointerEventType.SET_PRIMARY
    ]);
    expect(result.events.map((event) => event.event_sequence)).toEqual([0, 1]);
    const [row] = result.packages;
    expect(row).toMatchObject({
      id: 'draft-1',
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      production_valid: true,
      published_at: T,
      created_at: 1_790_000_000_000,
      publication_cid: first.publicationCid,
      cms_package: first.cmsPackage,
      storage_uri: `ar://${'a'.repeat(43)}`
    });
    expect(row.recovery_receipt).toMatchObject({
      provider: 'ipfs',
      uri: `ipfs://${first.publicationCid}`
    });
    expect(result.signature).toMatchObject({
      typed_data_hash: first.typedDataHash,
      package_db_id: 'draft-1',
      signer_address: CHAIN_FIXTURE_WALLET.address.toLowerCase()
    });
    expect(result.events[0]).toMatchObject({
      signer_address: CHAIN_FIXTURE_WALLET.address.toLowerCase(),
      typed_data_hash: first.typedDataHash,
      chain_height: 100,
      created_at: T
    });
  });

  it("keeps a draft row's creation fields when it publishes it", async () => {
    const draft = aPublishedRow(first, {
      status: ProfileCmsPackageStatus.DRAFT,
      is_primary: false,
      published_at: null,
      created_at: 5,
      created_by_profile_id: 'test-proxy',
      publication_cid: null
    });
    const result = transition({
      targetRow: draft,
      target: { kind: 'publication', checked: await checked(first) }
    });
    expect(result.packages[0]).toMatchObject({
      created_at: 5,
      created_by_profile_id: 'test-proxy',
      published_by_profile_id: CHAIN_FIXTURE_PROFILE_ID,
      status: ProfileCmsPackageStatus.PUBLISHED
    });
  });

  it('supersedes the old primary when a new version is published', async () => {
    const current = aPublishedRow(first);
    const result = transition({
      currentPrimary: current,
      target: { kind: 'publication', checked: await checked(second) }
    });
    expect(
      result.events.map((event) => [
        event.event_type,
        event.package_db_id,
        event.previous_package_db_id
      ])
    ).toEqual([
      [ProfileCmsPointerEventType.PUBLISH, 'draft-2', 'draft-1'],
      [ProfileCmsPointerEventType.SUPERSEDE, 'draft-1', 'draft-2'],
      [ProfileCmsPointerEventType.SET_PRIMARY, 'draft-2', 'draft-1']
    ]);
    expect(result.packages[0]).toMatchObject({
      id: 'draft-1',
      status: ProfileCmsPackageStatus.SUPERSEDED,
      is_primary: false,
      superseded_by_id: 'draft-2',
      updated_at: T
    });
  });

  it('rolls back to a package that was published before', async () => {
    const current = aPublishedRow(second);
    const earlier = aPublishedRow(first, {
      status: ProfileCmsPackageStatus.SUPERSEDED,
      is_primary: false,
      superseded_by_id: 'draft-2'
    });
    const result = transition({
      currentPrimary: current,
      targetRow: earlier,
      target: { kind: 'publication', checked: await checked(first) }
    });
    expect(result.events.map((event) => event.event_type)).toEqual([
      ProfileCmsPointerEventType.ROLLBACK,
      ProfileCmsPointerEventType.SUPERSEDE,
      ProfileCmsPointerEventType.SET_PRIMARY
    ]);
    expect(result.events.every((event) => event.signature === null)).toBe(true);
    expect(result.signature).toBeNull();
    expect(result.packages[1]).toMatchObject({
      id: 'draft-1',
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      superseded_by_id: null,
      published_at: 2
    });
  });

  it('unpublishes when the document names no site', () => {
    const current = aPublishedRow(first);
    const result = transition({
      currentPrimary: current,
      target: { kind: 'none' }
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      event_type: ProfileCmsPointerEventType.UNPUBLISH,
      package_db_id: 'draft-1',
      previous_package_db_id: 'draft-1'
    });
    expect(result.packages[0]).toMatchObject({
      is_primary: false,
      status: ProfileCmsPackageStatus.SUPERSEDED
    });
    expect(result.refused).toBeNull();
  });

  it('stops serving a site that fails the checks, and says why', () => {
    const current = aPublishedRow(first);
    const result = transition({
      currentPrimary: current,
      target: { kind: 'invalid', reason: 'signature_invalid_eoa_signature' }
    });
    expect(result.events[0].event_type).toBe(
      ProfileCmsPointerEventType.UNPUBLISH
    );
    expect(result.refused).toBe('signature_invalid_eoa_signature');
  });

  it('does nothing when the document keeps the same publication', async () => {
    const current = aPublishedRow(first);
    const result = transition({
      currentPrimary: current,
      targetRow: current,
      target: { kind: 'publication', checked: await checked(first) }
    });
    expect(result).toEqual({
      packages: [],
      events: [],
      signature: null,
      refused: null
    });
    expect(transition({ target: { kind: 'none' } })).toEqual({
      packages: [],
      events: [],
      signature: null,
      refused: null
    });
  });

  it('records a newer publication of the same package without events', async () => {
    const current = aPublishedRow(first, { publication_cid: null });
    const result = transition({
      currentPrimary: current,
      targetRow: current,
      target: { kind: 'publication', checked: await checked(first) }
    });
    expect(result.events).toEqual([]);
    expect(result.packages[0].publication_cid).toBe(first.publicationCid);
  });

  it('refuses a publication whose draft id belongs to another profile', async () => {
    const result = transition({
      targetRow: aPublishedRow(first, { profile_id: 'test-profile-2' }),
      target: { kind: 'publication', checked: await checked(first) }
    });
    expect(result.refused).toBe('package_row_of_another_profile');
    expect(result.events).toEqual([]);
  });

  it('keys event ids on the document version, not its bytes', async () => {
    const target: ProfileCmsChainTarget = {
      kind: 'publication',
      checked: await checked(first)
    };
    const ids = (version: number, docCid: string) =>
      transition({ version, docCid, target }).events.map((event) => event.id);
    expect(ids(2, 'bafkreia')).toEqual(ids(2, 'bafkreib'));
    expect(ids(2, 'bafkreia')).not.toEqual(ids(3, 'bafkreia'));
    expect(new Set(ids(2, 'bafkreia')).size).toBe(2);
  });
});
