import {
  CMS_CANONICALIZATION,
  CMS_HASH_ALGORITHM,
  CMS_PACKAGE_SCHEMA,
  CMS_PAYLOAD_SCHEMA,
  CmsPackageV1,
  withComputedCmsHashes
} from '@/profile-cms/protocol/v1';

export const PROFILE_CMS_FIXTURE_ZERO_HASH = `sha256:${'0'.repeat(64)}`;
export const PROFILE_CMS_FIXTURE_HANDLE = 'punk6529bot';
export const PROFILE_CMS_FIXTURE_PROFILE_ID = 'profile-1';

interface ProfileCmsPackageFixtureOptions {
  readonly handle?: string;
  readonly profileId?: string;
}

export function createValidProfileCmsPackage(
  options: ProfileCmsPackageFixtureOptions = {}
): CmsPackageV1 {
  const handle = options.handle ?? PROFILE_CMS_FIXTURE_HANDLE;
  const profileId = options.profileId ?? PROFILE_CMS_FIXTURE_PROFILE_ID;

  return withComputedCmsHashes({
    schema: CMS_PACKAGE_SCHEMA,
    package_id: 'profile-native-home',
    profile: {
      handle,
      profile_id: profileId,
      primary_wallet: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0'
    },
    site: {
      title: 'Punk 6529 Bot',
      description: 'Profile native CMS test package',
      base_path: `/${handle}/index.html`,
      default_locale: 'en-US',
      theme: { mode: 'dark', accent: '#29ccff' },
      navigation_id: 'main-nav'
    },
    payload: {
      schema: CMS_PAYLOAD_SCHEMA,
      routes: [
        {
          path: `/${handle}/index.html`,
          kind: 'page',
          page_id: 'home-page'
        }
      ],
      pages: [
        {
          id: 'home-page',
          type: 'page',
          path: `/${handle}/index.html`,
          metadata: {
            title: 'Punk 6529 Bot',
            description: 'Profile native CMS test package',
            locale: 'en-US',
            canonical_url: `https://6529.io/${handle}/index.html`
          },
          blocks: [createRichTextBlock()]
        }
      ],
      assets: [],
      navigation: [
        {
          id: 'main-nav',
          items: [{ label: 'Home', page_id: 'home-page' }]
        }
      ],
      build_manifest: { route_count: 1, asset_count: 0 }
    },
    integrity: {
      canonicalization: CMS_CANONICALIZATION,
      hash_algorithm: CMS_HASH_ALGORITHM,
      payload_hash: PROFILE_CMS_FIXTURE_ZERO_HASH,
      package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH
    },
    signatures: [
      {
        type: 'eip712',
        signer: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0',
        signature: '0x1234',
        signed_at: '2026-06-17T00:00:00.000Z'
      }
    ],
    storage: [
      {
        provider: 'ipfs',
        uri: 'ipfs://bafybeicmsv1fixture',
        content_hash: PROFILE_CMS_FIXTURE_ZERO_HASH,
        provider_content_id: 'bafybeicmsv1fixture',
        pinned: true,
        canonical: true,
        recorded_at: '2026-06-17T00:00:00.000Z'
      }
    ],
    provenance: {
      builder: 'backend-test',
      builder_version: '0.1.0',
      created_at: '2026-06-17T00:00:00.000Z'
    }
  });
}

export function createFixtureProfileCmsSignature(): CmsPackageV1['signatures'][number] {
  return {
    type: 'fixture',
    signer: 'fixture',
    signature: 'fixture',
    signed_at: '2026-06-17T00:00:00.000Z'
  };
}

export function createFixtureProfileCmsStorageReceipt(): CmsPackageV1['storage'][number] {
  return {
    provider: 'fixture',
    uri: 'https://fixtures.6529.io/profile-cms/package.json',
    content_hash: PROFILE_CMS_FIXTURE_ZERO_HASH,
    provider_content_id: 'fixture-profile-cms',
    pinned: false,
    canonical: true,
    recorded_at: '2026-06-17T00:00:00.000Z'
  };
}

function createRichTextBlock(): CmsPackageV1['payload']['pages'][number]['blocks'][number] {
  return {
    id: 'b1',
    block_type: 'rich_text',
    content: 'gm from CMS V1'
  } as CmsPackageV1['payload']['pages'][number]['blocks'][number];
}
