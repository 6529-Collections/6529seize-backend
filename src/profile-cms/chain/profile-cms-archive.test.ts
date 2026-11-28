import {
  archiveOwnershipProblem,
  encodeProfileCmsArchive,
  ProfileCmsArchive,
  readProfileCmsArchive
} from '@/profile-cms/chain/profile-cms-archive';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { ProfileCmsPointerEventType } from '@/entities/IProfileCmsPointerEvent';

const CID = 'bafkreiej3lbdjacakabv566nmsdidmktb6sxt765d7skg2sakrog2ttsiq';
const HASH = `sha256:${'2'.repeat(64)}`;

function anArchive(): ProfileCmsArchive {
  return {
    schema: '6529.cms.archive.v1',
    profile_id: 'test-profile-1',
    profile_handle: 'testhandle',
    frozen_at: 1,
    packages: [
      {
        id: 'draft-1',
        profile_id: 'test-profile-1',
        profile_handle: 'testhandle',
        package_id: 'home',
        version: 1,
        status: ProfileCmsPackageStatus.PUBLISHED,
        package: CID,
        envelope: {
          integrity: {
            canonicalization: 'jcs-rfc8785',
            hash_algorithm: 'sha256',
            payload_hash: HASH,
            package_hash: HASH
          },
          signatures: [],
          storage: []
        },
        publication: null,
        publication_rebuilt: false,
        payload_hash: HASH,
        package_hash: HASH,
        primary_path: '/testhandle/index.html',
        is_primary: true,
        production_valid: true,
        created_by_profile_id: 'test-profile-1',
        published_by_profile_id: 'test-profile-1',
        created_at: 1,
        updated_at: 1,
        validated_at: 1,
        published_at: 1,
        failed_at: null,
        archived_at: null,
        superseded_by_id: null,
        validation_result: null,
        validation_error: null,
        storage_receipts: [],
        storage_provider: null,
        storage_uri: null,
        storage_content_hash: null,
        storage_provider_content_id: null,
        storage_recorded_at: null,
        storage_pinned: null,
        storage_canonical: null,
        recovery_receipt: null
      }
    ],
    pointer_events: [
      {
        id: 'event-1',
        event_type: ProfileCmsPointerEventType.PUBLISH,
        profile_id: 'test-profile-1',
        profile_handle: 'testhandle',
        package_db_id: 'draft-1',
        package_id: 'home',
        package_version: 1,
        package_hash: HASH,
        payload_hash: HASH,
        previous_package_db_id: null,
        actor_profile_id: 'test-profile-1',
        signer_address: null,
        signature: null,
        typed_data: null,
        typed_data_hash: null,
        storage_receipt: null,
        event_sequence: 0,
        created_at: 1
      }
    ],
    publish_signatures: [
      {
        id: 'sig-1',
        typed_data_hash: '0xabc',
        profile_id: 'test-profile-1',
        package_db_id: 'draft-1',
        package_id: 'home',
        package_version: 1,
        package_hash: HASH,
        signer_address: '0x0000000000000000000000000000000000000001',
        deadline: 1,
        created_at: 1
      }
    ],
    legacy: {
      sites: [
        {
          id: 'site-a',
          owner_profile_id: 'test-profile-1',
          slug: 'a',
          title: 'A',
          description: null,
          primary_package_hash: HASH,
          primary_static_path: '/a',
          created_at: 1,
          updated_at: 1,
          created_by_wallet: '0x0000000000000000000000000000000000000001',
          updated_by_wallet: null
        }
      ],
      packages: [
        {
          package_hash: HASH,
          payload_hash: HASH,
          schema: 'legacy',
          site_id: 'site-a',
          owner_profile_id: 'test-profile-1',
          title: 'A',
          description: null,
          static_path: '/a',
          canonical_url: null,
          package_json: CID,
          storage_json: [],
          signature_json: {},
          published_at: 1,
          published_by_wallet: '0x0000000000000000000000000000000000000001',
          signature_check: { verified: false, form: null, signer: null }
        }
      ]
    }
  };
}

describe('profile site archives', () => {
  it('round-trips through its canonical bytes', () => {
    const archive = anArchive();
    expect(readProfileCmsArchive(encodeProfileCmsArchive(archive))).toEqual({
      ok: true,
      archive
    });
  });

  it('accepts an archive whose rows all belong to its profile', () => {
    expect(archiveOwnershipProblem(anArchive())).toBeNull();
  });

  it.each([
    [
      'a package of another profile',
      (a: ProfileCmsArchive) => {
        (a.packages[0] as { profile_id: string }).profile_id = 'victim';
      },
      'package_of_another_profile'
    ],
    [
      'an event of another profile',
      (a: ProfileCmsArchive) => {
        (a.pointer_events[0] as { profile_id: string }).profile_id = 'victim';
      },
      'pointer_event_of_another_profile'
    ],
    [
      'a signature of another profile',
      (a: ProfileCmsArchive) => {
        (a.publish_signatures[0] as { profile_id: string }).profile_id =
          'victim';
      },
      'publish_signature_of_another_profile'
    ],
    [
      'an event of a package not in the archive',
      (a: ProfileCmsArchive) => {
        (a.pointer_events[0] as { package_db_id: string }).package_db_id =
          'victims-package';
      },
      'history_of_a_package_not_in_the_archive'
    ],
    [
      "another owner's legacy site",
      (a: ProfileCmsArchive) => {
        (a.legacy.sites[0] as { owner_profile_id: string }).owner_profile_id =
          'victim';
      },
      'legacy_site_of_another_profile'
    ],
    [
      'a legacy package of a site not in the archive',
      (a: ProfileCmsArchive) => {
        (a.legacy.packages[0] as { site_id: string }).site_id = 'victims-site';
      },
      'legacy_package_of_another_site'
    ]
  ])('refuses %s', (_name, mutate, reason) => {
    const archive = anArchive();
    mutate(archive);
    expect(archiveOwnershipProblem(archive)).toBe(reason);
  });
});
