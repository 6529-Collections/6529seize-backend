import fc from 'fast-check';

import { CmsPackageV1, validateCmsPackageV1 } from '@/profile-cms/protocol/v1';

import {
  createFixtureProfileCmsGallerySnapshot,
  generateProfileCmsGalleryPackage,
  ProfileCmsGallerySnapshotNft,
  ProfileCmsGalleryWalletSnapshot,
  toProfileCmsGalleryCollectionKey
} from './profile-cms-gallery-package-generator';

const CHECKED_AT = '2026-06-18T00:00:00.000Z';
const MEDIA_ROLES = [
  'grid',
  'detail',
  'social',
  'original',
  'thumbnail'
] as const;
const DISPLAY_VARIANT_ROLES = ['grid', 'detail', 'social'] as const;

describe('profile CMS gallery package generator', () => {
  it('generates deterministic CMS V1 packages from shuffled snapshots', () => {
    const snapshot = createFixtureProfileCmsGallerySnapshot();
    const shuffledSnapshot = {
      ...snapshot,
      nfts: [...snapshot.nfts].reverse()
    };

    const firstPackage = generateProfileCmsGalleryPackage({ snapshot });
    const shuffledPackage = generateProfileCmsGalleryPackage({
      snapshot: shuffledSnapshot
    });

    expect(shuffledPackage).toEqual(firstPackage);
    expect(routePaths(firstPackage)).toEqual([
      '/punk6529bot/index.html',
      '/punk6529bot/collections/index.html',
      '/punk6529bot/collections/the-memes/index.html',
      '/punk6529bot/collections/meme-lab/index.html',
      '/punk6529bot/nfts/the-memes-1-1/index.html',
      '/punk6529bot/nfts/meme-lab-42-42/index.html'
    ]);
    expect(hasUniqueRoutes(firstPackage)).toBe(true);
    expect(validateForDraft(firstPackage).valid).toBe(true);
  });

  it('groups collections and applies hide, feature, and reorder controls', () => {
    const snapshot = createFixtureProfileCmsGallerySnapshot();
    const firstMeme = {
      ...snapshot.nfts[0],
      featured: false
    };
    const secondMeme: ProfileCmsGallerySnapshotNft = {
      ...firstMeme,
      key: 'meme-2',
      token_id: '2',
      name: 'The Memes #2',
      description: 'The second fixture Meme card.',
      media: undefined
    };
    const curatedPackage = generateProfileCmsGalleryPackage({
      snapshot: {
        ...snapshot,
        nfts: [snapshot.nfts[1], firstMeme, secondMeme]
      },
      curation: {
        hidden_collection_keys: ['meme-lab'],
        featured_nft_keys: ['meme-2'],
        collection_nft_order: {
          [toProfileCmsGalleryCollectionKey(firstMeme)]: ['meme-2', 'meme-1']
        }
      }
    });

    expect(routePaths(curatedPackage)).toEqual([
      '/punk6529bot/index.html',
      '/punk6529bot/collections/index.html',
      '/punk6529bot/collections/the-memes/index.html',
      '/punk6529bot/nfts/the-memes-2-2/index.html',
      '/punk6529bot/nfts/the-memes-1-1/index.html'
    ]);
    expect(
      blockById(curatedPackage, 'collection-the-memes-gallery')?.page_ids
    ).toEqual(['nft-the-memes-2-2', 'nft-the-memes-1-1']);
    expect(
      blockById(curatedPackage, 'home-wallet-gallery')?.featured_page_ids
    ).toEqual(['nft-the-memes-2-2']);
    expect(validateForDraft(curatedPackage).valid).toBe(true);
  });

  it('keeps featured_page_ids empty when no NFTs are explicitly featured', () => {
    const snapshot = createFixtureProfileCmsGallerySnapshot();
    const unfeaturedPackage = generateProfileCmsGalleryPackage({
      snapshot: {
        ...snapshot,
        nfts: snapshot.nfts.map((nft) => ({
          ...nft,
          featured: false,
          collection: nft.collection
            ? { ...nft.collection, featured: false }
            : undefined
        }))
      }
    });

    expect(
      blockById(unfeaturedPackage, 'home-wallet-gallery')?.featured_page_ids
    ).toEqual([]);
    expect(
      blockById(unfeaturedPackage, 'home-wallet-gallery')?.page_ids
    ).toHaveLength(2);
    expect(validateForDraft(unfeaturedPackage).valid).toBe(true);
  });

  it('generates a valid empty gallery for zero-NFT snapshots', () => {
    const snapshot = createFixtureProfileCmsGallerySnapshot();
    const emptyPackage = generateProfileCmsGalleryPackage({
      snapshot: { ...snapshot, nfts: [] }
    });

    expect(routePaths(emptyPackage)).toEqual([
      '/punk6529bot/index.html',
      '/punk6529bot/collections/index.html'
    ]);
    expect(
      blockById(emptyPackage, 'home-wallet-gallery')?.featured_page_ids
    ).toEqual([]);
    expect(blockById(emptyPackage, 'home-wallet-gallery')?.page_ids).toEqual(
      []
    );
    expect(sourcePacketById(emptyPackage, 'wallet-snapshot')?.nft_count).toBe(
      0
    );
    expect(validateForDraft(emptyPackage).valid).toBe(true);
  });

  it('truncates long unicode metadata without splitting surrogate pairs', () => {
    const snapshot = createFixtureProfileCmsGallerySnapshot();
    const cmsPackage = generateProfileCmsGalleryPackage({
      snapshot,
      site: {
        title: `${'A'.repeat(159)}😀`,
        description: `${'B'.repeat(299)}😀`
      }
    });
    const homePage = pageById(cmsPackage, 'home-page');

    expect(homePage?.metadata.title.endsWith('\uD83D')).toBe(false);
    expect(homePage?.metadata.description.endsWith('\uD83D')).toBe(false);
    expect(validateForDraft(cmsPackage).valid).toBe(true);
  });

  it('generates NFT detail pages with media profiles and social references when media is complete', () => {
    const cmsPackage = generateProfileCmsGalleryPackage();
    const detailPage = pageById(cmsPackage, 'nft-the-memes-1-1');
    const mediaProfile = cmsPackage.payload.nft_media_profiles?.find(
      (profile) => profile.id === 'media-the-memes-1-1'
    );

    expect(detailPage?.type).toBe('nft_detail');
    expect(detailPage?.metadata.social_image_asset_id).toBe(
      'asset-the-memes-1-1-social-3'
    );
    expect(mediaProfile).toMatchObject({
      chain_id: 1,
      token_id: '1',
      poster_asset_id: 'asset-the-memes-1-1-grid-1',
      display_variants: [
        {
          asset_id: 'asset-the-memes-1-1-grid-1',
          role: 'grid',
          crop_mode: 'cover'
        },
        {
          asset_id: 'asset-the-memes-1-1-detail-2',
          role: 'detail',
          crop_mode: 'preserve'
        },
        {
          asset_id: 'asset-the-memes-1-1-social-3',
          role: 'social',
          crop_mode: 'cover'
        }
      ]
    });
    expect(blockById(cmsPackage, 'nft-the-memes-1-1-reference')).toMatchObject({
      block_type: 'nft_reference',
      nft_media_profile_id: 'media-the-memes-1-1'
    });
    expect(validateForDraft(cmsPackage).valid).toBe(true);
  });

  it('surfaces validation failures for publish-only fixture artifacts and route collisions', () => {
    const cmsPackage = generateProfileCmsGalleryPackage();
    const productionValidation = validateCmsPackageV1(cmsPackage, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      enforceHashes: true,
      checkedAt: CHECKED_AT
    });
    const invalidRoutesPackage: CmsPackageV1 = {
      ...cmsPackage,
      payload: {
        ...cmsPackage.payload,
        routes: [...cmsPackage.payload.routes, cmsPackage.payload.routes[0]]
      }
    };
    const routeValidation = validateForDraft(invalidRoutesPackage);

    expect(productionValidation.valid).toBe(false);
    expect(issueCodes(productionValidation)).toEqual([
      'signature.fixture_not_allowed',
      'storage.decentralized_receipt_required',
      'storage.fixture_not_allowed'
    ]);
    expect(routeValidation.valid).toBe(false);
    expect(issueCodes(routeValidation)).toContain('route.duplicate_path');
  });

  it('rejects malformed generator inputs before package generation', () => {
    const snapshot = createFixtureProfileCmsGallerySnapshot();
    const firstNft = snapshot.nfts[0];
    const firstMedia = firstNft.media;
    if (!firstMedia?.assets || firstMedia.assets.length < 2) {
      throw new Error('Fixture NFT media assets are required for this test.');
    }
    const firstAssets = firstMedia.assets;
    const duplicateAssetKeySnapshot: ProfileCmsGalleryWalletSnapshot = {
      ...snapshot,
      nfts: [
        {
          ...firstNft,
          media: {
            ...firstMedia,
            assets: [
              firstAssets[0],
              { ...firstAssets[1], key: firstAssets[0].key }
            ]
          }
        },
        snapshot.nfts[1]
      ]
    };

    expect(() =>
      generateProfileCmsGalleryPackage({ snapshot: duplicateAssetKeySnapshot })
    ).toThrow('Duplicate media asset lookup key');
    expect(() =>
      generateProfileCmsGalleryPackage({
        snapshot: {
          ...snapshot,
          nfts: [{ ...firstNft, token_id: Number.POSITIVE_INFINITY }]
        }
      })
    ).toThrow('finite string or number');
    expect(() =>
      generateProfileCmsGalleryPackage({
        snapshot: {
          ...snapshot,
          nfts: [{ ...firstNft, token_id: '   ' }]
        }
      })
    ).toThrow('non-empty');
  });

  it('keeps route paths unique for random colliding names', () => {
    fc.assert(
      fc.property(
        fc.array(randomNftRecordArbitrary(), {
          minLength: 1,
          maxLength: 8
        }),
        (records) => {
          const snapshot = snapshotWithNftRecords(records);
          const cmsPackage = generateProfileCmsGalleryPackage({ snapshot });

          expect(hasUniqueRoutes(cmsPackage)).toBe(true);
          expect(hasUniquePageIds(cmsPackage)).toBe(true);
          expect(hasUniqueAssetIds(cmsPackage)).toBe(true);
          expect(validateForDraft(cmsPackage).valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

function validateForDraft(cmsPackage: CmsPackageV1) {
  return validateCmsPackageV1(cmsPackage, {
    allowFixtureSignatures: true,
    allowFixtureStorage: true,
    enforceHashes: true,
    checkedAt: CHECKED_AT
  });
}

function routePaths(cmsPackage: CmsPackageV1): string[] {
  return cmsPackage.payload.routes.map((route) => route.path);
}

function hasUniqueRoutes(cmsPackage: CmsPackageV1): boolean {
  const paths = routePaths(cmsPackage);
  return new Set(paths).size === paths.length;
}

function hasUniquePageIds(cmsPackage: CmsPackageV1): boolean {
  const pageIds = cmsPackage.payload.pages.map((page) => page.id);
  return new Set(pageIds).size === pageIds.length;
}

function hasUniqueAssetIds(cmsPackage: CmsPackageV1): boolean {
  const assetIds = cmsPackage.payload.assets.map((asset) => asset.id);
  return new Set(assetIds).size === assetIds.length;
}

function issueCodes(
  validationResult: ReturnType<typeof validateCmsPackageV1>
): string[] {
  return validationResult.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code)
    .sort((left, right) => left.localeCompare(right));
}

function pageById(cmsPackage: CmsPackageV1, pageId: string) {
  return cmsPackage.payload.pages.find((page) => page.id === pageId);
}

function blockById(cmsPackage: CmsPackageV1, blockId: string) {
  return cmsPackage.payload.pages
    .map((page) => page.blocks.find((block) => block.id === blockId))
    .find((block) => !!block) as Record<string, unknown> | undefined;
}

function sourcePacketById(cmsPackage: CmsPackageV1, packetId: string) {
  return cmsPackage.payload.source_packets?.find(
    (packet) => packet.id === packetId
  ) as Record<string, unknown> | undefined;
}

interface RandomNftRecord {
  readonly name: string;
  readonly tokenId: string;
  readonly collectionName: string;
  readonly mediaRole?: (typeof MEDIA_ROLES)[number];
}

function randomNftRecordArbitrary() {
  const nonEmptyText = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((value) => value.trim().length > 0);
  return fc.record({
    name: fc.oneof(
      fc.constantFrom('Home', 'Collections Index', 'Same!!!', 'NFT'),
      fc.string({ maxLength: 40 })
    ),
    tokenId: fc.oneof(
      fc.constantFrom('page', 'index', '1', '01', 'collections-index'),
      fc.integer({ min: 0, max: 1_000_000 }).map(String),
      nonEmptyText
    ),
    collectionName: fc.oneof(
      fc.constantFrom('Home', 'Collections Index', 'Same Collection'),
      nonEmptyText
    ),
    mediaRole: fc.option(fc.constantFrom(...MEDIA_ROLES), { nil: undefined })
  });
}

function snapshotWithNftRecords(
  records: readonly RandomNftRecord[]
): ProfileCmsGalleryWalletSnapshot {
  const fixture = createFixtureProfileCmsGallerySnapshot();
  return {
    ...fixture,
    nfts: records.map((record, index) => {
      const contract = addressForIndex(index + 1);
      const nft: ProfileCmsGallerySnapshotNft = {
        key: `random-${index}`,
        chain_id: 1,
        contract,
        token_id: record.tokenId,
        name: record.name,
        collection: {
          key: `collection-${index % 2}`,
          name: record.collectionName,
          description: 'A property-test collection.'
        },
        ...(record.mediaRole
          ? { media: mediaForRecord(index, record.mediaRole) }
          : {})
      };
      return nft;
    })
  };
}

function mediaForRecord(
  index: number,
  role: (typeof MEDIA_ROLES)[number]
): NonNullable<ProfileCmsGallerySnapshotNft['media']> {
  const key = `asset-${index}`;
  return {
    assets: [
      {
        key,
        uri: `https://images.6529.io/property/${index}.png`,
        content_hash: `sha256:${String(index).padStart(64, '0')}`,
        mime_type: 'image/png',
        kind: role === 'social' ? 'social_image' : 'image',
        width: 1000,
        height: 1000,
        roles: [role]
      }
    ],
    ...(isDisplayVariantRole(role)
      ? { display_variants: [{ asset_key: key, role, crop_mode: 'cover' }] }
      : {})
  };
}

function isDisplayVariantRole(
  role: (typeof MEDIA_ROLES)[number]
): role is (typeof DISPLAY_VARIANT_ROLES)[number] {
  return DISPLAY_VARIANT_ROLES.includes(
    role as (typeof DISPLAY_VARIANT_ROLES)[number]
  );
}

function addressForIndex(index: number): string {
  const hex = index.toString(16);
  return `0x${'0'.repeat(40 - hex.length)}${hex}`;
}
