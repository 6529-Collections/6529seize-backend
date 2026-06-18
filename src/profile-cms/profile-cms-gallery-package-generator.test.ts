import fc from 'fast-check';

import { CmsPackageV1, validateCmsPackageV1 } from '@/profile-cms/protocol/v1';

import {
  createFixtureProfileCmsGallerySnapshot,
  generateProfileCmsGalleryPackage,
  ProfileCmsGallerySnapshotNft,
  ProfileCmsGalleryWalletSnapshot
} from './profile-cms-gallery-package-generator';

const CHECKED_AT = '2026-06-18T00:00:00.000Z';

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
        nft_order: ['meme-2', 'meme-1']
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

  it('keeps route paths unique for random colliding names', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), {
          minLength: 1,
          maxLength: 8
        }),
        (names) => {
          const snapshot = snapshotWithNftNames(names);
          const cmsPackage = generateProfileCmsGalleryPackage({ snapshot });

          expect(hasUniqueRoutes(cmsPackage)).toBe(true);
          expect(validateForDraft(cmsPackage).valid).toBe(true);
        }
      ),
      { numRuns: 25 }
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

function snapshotWithNftNames(
  names: readonly string[]
): ProfileCmsGalleryWalletSnapshot {
  const fixture = createFixtureProfileCmsGallerySnapshot();
  return {
    ...fixture,
    nfts: names.map((name, index) => {
      const tokenId = String(index + 1);
      const contract = addressForIndex(index + 1);
      const nft: ProfileCmsGallerySnapshotNft = {
        key: `random-${index}`,
        chain_id: 1,
        contract,
        token_id: tokenId,
        name,
        collection: {
          key: `collection-${index % 2}`,
          name: 'Same Collection',
          description: 'A property-test collection.'
        }
      };
      return nft;
    })
  };
}

function addressForIndex(index: number): string {
  const hex = index.toString(16);
  return `0x${'0'.repeat(40 - hex.length)}${hex}`;
}
