import {
  CMS_CANONICALIZATION,
  CMS_HASH_ALGORITHM,
  CMS_PACKAGE_SCHEMA,
  CMS_PAYLOAD_SCHEMA,
  CmsPackageV1,
  toCmsSha256Hash,
  withComputedCmsHashes
} from '@/profile-cms/protocol/v1';

export const PROFILE_CMS_GALLERY_GENERATOR_NAME =
  '6529-backend-profile-cms-gallery-generator';
export const PROFILE_CMS_GALLERY_GENERATOR_VERSION = '0.1.0';
export const PROFILE_CMS_GALLERY_FIXTURE_TIMESTAMP = '2026-06-18T00:00:00.000Z';
export const PROFILE_CMS_GALLERY_FIXTURE_ZERO_HASH = `sha256:${'0'.repeat(64)}`;

type CmsAssetV1 = CmsPackageV1['payload']['assets'][number];
type CmsAssetKind = CmsAssetV1['kind'];
type CmsAssetRole = NonNullable<CmsAssetV1['roles']>[number];
type CmsBlockV1 = CmsPackageV1['payload']['pages'][number]['blocks'][number];
type CmsPageV1 = CmsPackageV1['payload']['pages'][number];
type CmsDisplayVariantRole = NonNullable<
  CmsPackageV1['payload']['nft_media_profiles']
>[number]['display_variants'][number]['role'];
type CmsSignatureV1 = CmsPackageV1['signatures'][number];
type CmsStorageReceiptV1 = CmsPackageV1['storage'][number];

export interface ProfileCmsGalleryPackageGenerationInput {
  readonly snapshot?: ProfileCmsGalleryWalletSnapshot;
  readonly curation?: ProfileCmsGalleryCurationInput;
  readonly package_id?: string;
  readonly site?: ProfileCmsGallerySiteInput;
  readonly signatures?: readonly CmsSignatureV1[];
  readonly storage?: readonly CmsStorageReceiptV1[];
  readonly provenance?: ProfileCmsGalleryProvenanceInput;
}

export interface ProfileCmsGalleryWalletSnapshot {
  readonly profile: ProfileCmsGallerySnapshotProfile;
  readonly owner?: string;
  readonly wallets?: readonly string[];
  readonly block_number?: number;
  readonly captured_at?: string;
  readonly nfts: readonly ProfileCmsGallerySnapshotNft[];
}

export interface ProfileCmsGallerySnapshotProfile {
  readonly handle: string;
  readonly profile_id?: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly primary_wallet?: string;
  readonly canonical_base_url?: string;
}

export interface ProfileCmsGallerySnapshotCollection {
  readonly key?: string;
  readonly id?: string;
  readonly slug?: string;
  readonly name: string;
  readonly description?: string;
  readonly artist?: string;
  readonly hidden?: boolean;
  readonly featured?: boolean;
  readonly order?: number;
}

export interface ProfileCmsGallerySnapshotNft {
  readonly key?: string;
  readonly id?: string;
  readonly chain_id: number;
  readonly contract: string;
  readonly token_id: string | number;
  readonly name?: string;
  readonly description?: string;
  readonly collection?: ProfileCmsGallerySnapshotCollection;
  readonly media?: ProfileCmsGallerySnapshotNftMedia;
  readonly hidden?: boolean;
  readonly featured?: boolean;
  readonly order?: number;
}

export interface ProfileCmsGallerySnapshotNftMedia {
  readonly metadata_uri?: string;
  readonly metadata_hash?: string;
  readonly assets?: readonly ProfileCmsGalleryMediaAssetInput[];
  readonly display_variants?: readonly ProfileCmsGalleryDisplayVariantInput[];
  readonly poster_asset_key?: string;
}

export interface ProfileCmsGalleryMediaAssetInput {
  readonly key?: string;
  readonly uri: string;
  readonly content_hash: string;
  readonly mime_type: string;
  readonly kind?: CmsAssetKind;
  readonly width?: number;
  readonly height?: number;
  readonly duration_seconds?: number;
  readonly file_size_bytes?: number;
  readonly roles?: readonly CmsAssetRole[];
  readonly alt_text?: string;
  readonly decorative?: boolean;
  readonly rights?: string;
}

export interface ProfileCmsGalleryDisplayVariantInput {
  readonly asset_key?: string;
  readonly role: CmsDisplayVariantRole;
  readonly crop_mode?: 'preserve' | 'cover' | 'contain';
  readonly background?: string;
  readonly source_asset_key?: string;
}

export interface ProfileCmsGalleryCurationInput {
  readonly hidden_nft_keys?: readonly string[];
  readonly hidden_collection_keys?: readonly string[];
  readonly featured_nft_keys?: readonly string[];
  readonly featured_collection_keys?: readonly string[];
  readonly nft_order?: readonly string[];
  readonly collection_order?: readonly string[];
  readonly collection_nft_order?: Readonly<Record<string, readonly string[]>>;
}

export interface ProfileCmsGallerySiteInput {
  readonly title?: string;
  readonly description?: string;
  readonly theme?: CmsPackageV1['site']['theme'];
  readonly canonical_base_url?: string;
  readonly locale?: string;
}

export interface ProfileCmsGalleryProvenanceInput {
  readonly builder?: string;
  readonly builder_version?: string;
  readonly created_at?: string;
  readonly notes?: string;
}

interface PreparedNft {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly chainId: number;
  readonly contract: string;
  readonly tokenId: string;
  readonly title: string;
  readonly description: string;
  readonly collectionKey: string;
  readonly collectionAliases: readonly string[];
  readonly collectionTitle: string;
  readonly collectionDescription: string;
  readonly media: ProfileCmsGallerySnapshotNftMedia | undefined;
  readonly hidden: boolean;
  readonly featured: boolean;
  readonly order: number | undefined;
  readonly collectionOrder: number | undefined;
}

interface PreparedCollection {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly featured: boolean;
  readonly order: number | undefined;
  readonly nfts: readonly PreparedNft[];
  readonly slug: string;
  readonly pageId: string;
  readonly path: string;
}

interface PreparedNftPage {
  readonly nft: PreparedNft;
  readonly slug: string;
  readonly pageId: string;
  readonly path: string;
}

interface GeneratedMedia {
  readonly assets: readonly CmsAssetV1[];
  readonly profile?: NonNullable<
    CmsPackageV1['payload']['nft_media_profiles']
  >[number];
  readonly primaryAssetId?: string;
  readonly socialAssetId?: string;
}

const DEFAULT_THEME: CmsPackageV1['site']['theme'] = {
  mode: 'dark',
  accent: '#29ccff'
};

export function generateProfileCmsGalleryPackage(
  input: ProfileCmsGalleryPackageGenerationInput = {}
): CmsPackageV1 {
  const snapshot = input.snapshot ?? createFixtureProfileCmsGallerySnapshot();
  const createdAt =
    input.provenance?.created_at ??
    snapshot.captured_at ??
    PROFILE_CMS_GALLERY_FIXTURE_TIMESTAMP;
  const packageId =
    input.package_id ??
    `${toProfileCmsGalleryRouteSlug(snapshot.profile.handle)}-gallery`;
  const canonicalBaseUrl =
    input.site?.canonical_base_url ??
    snapshot.profile.canonical_base_url ??
    'https://6529.io';
  const prepared = prepareGallery(snapshot, input.curation);
  const pagesByNftKey = prepareNftPages(snapshot.profile.handle, prepared.nfts);
  const assets: CmsAssetV1[] = [];
  const nftMediaProfiles: NonNullable<
    CmsPackageV1['payload']['nft_media_profiles']
  > = [];
  const mediaByNftKey = new Map<string, GeneratedMedia>();

  prepared.nfts.forEach((nft) => {
    const page = pagesByNftKey.get(nft.key);
    if (!page) {
      return;
    }
    const generatedMedia = generateMediaForNft(nft, page.slug);
    assets.push(...generatedMedia.assets);
    if (generatedMedia.profile) {
      nftMediaProfiles.push(generatedMedia.profile);
    }
    mediaByNftKey.set(nft.key, generatedMedia);
  });

  const homePage = buildHomePage({
    snapshot,
    collections: prepared.collections,
    nftPages: pagesByNftKey,
    mediaByNftKey,
    canonicalBaseUrl,
    siteTitle: getSiteTitle(snapshot, input.site),
    siteDescription: getSiteDescription(snapshot, input.site)
  });
  const collectionsIndexPage = buildCollectionsIndexPage({
    handle: snapshot.profile.handle,
    collections: prepared.collections,
    canonicalBaseUrl,
    siteTitle: getSiteTitle(snapshot, input.site),
    socialImageAssetId: getFirstSocialAssetId(prepared.nfts, mediaByNftKey)
  });
  const collectionPages = prepared.collections.map((collection) =>
    buildCollectionPage({
      collection,
      nftPages: pagesByNftKey,
      mediaByNftKey,
      canonicalBaseUrl
    })
  );
  const nftDetailPages = prepared.nfts
    .map((nft) => pagesByNftKey.get(nft.key))
    .filter((page): page is PreparedNftPage => !!page)
    .map((page) =>
      buildNftDetailPage({
        page,
        media: mediaByNftKey.get(page.nft.key),
        canonicalBaseUrl
      })
    );
  const pages = [
    homePage,
    collectionsIndexPage,
    ...collectionPages,
    ...nftDetailPages
  ];
  const routes = pages.map((page) => ({
    path: page.path,
    kind: 'page' as const,
    page_id: page.id
  }));
  const sourcePacket = buildWalletSourcePacket(snapshot, createdAt);
  const packageWithoutHashes: CmsPackageV1 = {
    schema: CMS_PACKAGE_SCHEMA,
    package_id: packageId,
    profile: {
      handle: snapshot.profile.handle,
      ...(snapshot.profile.profile_id
        ? { profile_id: snapshot.profile.profile_id }
        : {}),
      ...(snapshot.profile.primary_wallet
        ? {
            primary_wallet: normalizeEthereumAddress(
              snapshot.profile.primary_wallet
            )
          }
        : {})
    },
    site: {
      title: truncateText(getSiteTitle(snapshot, input.site), 160),
      description: truncateText(getSiteDescription(snapshot, input.site), 300),
      base_path: `/${snapshot.profile.handle}/index.html`,
      default_locale: input.site?.locale ?? 'en-US',
      theme: input.site?.theme ?? DEFAULT_THEME,
      navigation_id: 'main-nav',
      metadata_defaults: [
        {
          scope: { path_prefix: `/${snapshot.profile.handle}/` },
          values: {
            locale: input.site?.locale ?? 'en-US',
            robots: 'index',
            search: 'include'
          }
        }
      ]
    },
    payload: {
      schema: CMS_PAYLOAD_SCHEMA,
      routes,
      pages,
      assets,
      ...(nftMediaProfiles.length > 0
        ? { nft_media_profiles: nftMediaProfiles }
        : {}),
      navigation: [
        {
          id: 'main-nav',
          items: [
            { label: 'Gallery', page_id: homePage.id },
            { label: 'Collections', page_id: collectionsIndexPage.id }
          ]
        }
      ],
      taxonomies: [
        {
          id: 'collections',
          name: 'Collections',
          terms: prepared.collections.map((collection) => ({
            slug: collection.slug,
            label: collection.title,
            page_id: collection.pageId
          }))
        }
      ],
      source_packets: [sourcePacket],
      build_manifest: {
        renderer: PROFILE_CMS_GALLERY_GENERATOR_NAME,
        renderer_version: PROFILE_CMS_GALLERY_GENERATOR_VERSION,
        route_count: routes.length,
        asset_count: assets.length
      }
    },
    integrity: {
      canonicalization: CMS_CANONICALIZATION,
      hash_algorithm: CMS_HASH_ALGORITHM,
      payload_hash: PROFILE_CMS_GALLERY_FIXTURE_ZERO_HASH,
      package_hash: PROFILE_CMS_GALLERY_FIXTURE_ZERO_HASH
    },
    signatures: input.signatures
      ? [...input.signatures]
      : [createFixtureGallerySignature(createdAt)],
    storage: input.storage
      ? [...input.storage]
      : [createFixtureGalleryStorageReceipt(createdAt)],
    provenance: {
      builder: input.provenance?.builder ?? PROFILE_CMS_GALLERY_GENERATOR_NAME,
      builder_version:
        input.provenance?.builder_version ??
        PROFILE_CMS_GALLERY_GENERATOR_VERSION,
      created_at: createdAt,
      ...(input.provenance?.notes ? { notes: input.provenance.notes } : {})
    }
  };

  return withPackageHashStorageReceipts(
    withComputedCmsHashes(packageWithoutHashes),
    input.storage ? undefined : 'fixture'
  );
}

export function createFixtureProfileCmsGallerySnapshot(): ProfileCmsGalleryWalletSnapshot {
  const primaryWallet = '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0';
  const memesContract = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
  const labContract = '0x4db52a61dc491e15a2f78f5ac001c14ffe3568cb';

  return {
    profile: {
      handle: 'punk6529bot',
      profile_id: 'profile-1',
      display_name: 'Punk 6529 Bot',
      description: 'A deterministic profile-native gallery fixture.',
      primary_wallet: primaryWallet,
      canonical_base_url: 'https://6529.io'
    },
    owner: primaryWallet,
    wallets: [primaryWallet],
    block_number: 22652900,
    captured_at: PROFILE_CMS_GALLERY_FIXTURE_TIMESTAMP,
    nfts: [
      {
        key: 'meme-1',
        chain_id: 1,
        contract: memesContract,
        token_id: '1',
        name: 'The Memes #1',
        description: 'The first fixture Meme card.',
        featured: true,
        collection: {
          key: 'the-memes',
          id: 'the-memes',
          slug: 'the-memes',
          name: 'The Memes',
          description: 'The Memes by 6529.'
        },
        media: {
          metadata_uri: 'https://metadata.6529.io/memes/1.json',
          metadata_hash: hashFixtureString('metadata:memes:1'),
          assets: [
            createFixtureMediaAsset({
              key: 'memes-1-grid',
              uri: 'https://images.6529.io/memes/1-grid.png',
              role: 'grid',
              width: 900,
              height: 1200
            }),
            createFixtureMediaAsset({
              key: 'memes-1-detail',
              uri: 'https://images.6529.io/memes/1-detail.png',
              role: 'detail',
              width: 1800,
              height: 2400
            }),
            createFixtureMediaAsset({
              key: 'memes-1-social',
              uri: 'https://images.6529.io/memes/1-social.png',
              role: 'social',
              kind: 'social_image',
              width: 1200,
              height: 630
            })
          ],
          display_variants: [
            { asset_key: 'memes-1-grid', role: 'grid', crop_mode: 'cover' },
            {
              asset_key: 'memes-1-detail',
              role: 'detail',
              crop_mode: 'preserve'
            },
            { asset_key: 'memes-1-social', role: 'social', crop_mode: 'cover' }
          ],
          poster_asset_key: 'memes-1-grid'
        }
      },
      {
        key: 'meme-lab-42',
        chain_id: 1,
        contract: labContract,
        token_id: '42',
        name: 'Meme Lab #42',
        description: 'A fixture Meme Lab edition.',
        collection: {
          key: 'meme-lab',
          id: 'meme-lab',
          slug: 'meme-lab',
          name: 'Meme Lab',
          description: 'Experimental editions from the Meme Lab.'
        },
        media: {
          metadata_uri: 'https://metadata.6529.io/memelab/42.json',
          metadata_hash: hashFixtureString('metadata:memelab:42'),
          assets: [
            createFixtureMediaAsset({
              key: 'lab-42-grid',
              uri: 'https://images.6529.io/memelab/42-grid.png',
              role: 'grid',
              width: 1000,
              height: 1000
            })
          ],
          display_variants: [
            { asset_key: 'lab-42-grid', role: 'grid', crop_mode: 'cover' }
          ],
          poster_asset_key: 'lab-42-grid'
        }
      }
    ]
  };
}

export function toProfileCmsGalleryNftKey(
  nft: Pick<ProfileCmsGallerySnapshotNft, 'chain_id' | 'contract' | 'token_id'>
): string {
  return `${nft.chain_id}:${normalizeEthereumAddress(
    nft.contract
  )}:${normalizeTokenId(nft.token_id)}`;
}

export function toProfileCmsGalleryRouteSlug(
  value: string | number,
  fallback = 'item'
): string {
  const input = String(value).toLowerCase();
  const chars: string[] = [];
  let lastWasDash = false;
  for (let index = 0; index < input.length && chars.length < 72; index++) {
    const code = input.charCodeAt(index);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAlphaNumeric) {
      chars.push(input[index]);
      lastWasDash = false;
    } else if (!lastWasDash && chars.length > 0) {
      chars.push('-');
      lastWasDash = true;
    }
  }
  if (chars.length > 0 && chars[chars.length - 1] === '-') {
    chars.pop();
  }
  return chars.join('') || fallback;
}

function prepareGallery(
  snapshot: ProfileCmsGalleryWalletSnapshot,
  curation: ProfileCmsGalleryCurationInput = {}
): {
  readonly collections: readonly PreparedCollection[];
  readonly nfts: readonly PreparedNft[];
} {
  const hiddenNftKeys = toSet(curation.hidden_nft_keys);
  const hiddenCollectionKeys = toSet(curation.hidden_collection_keys);
  const featuredNftKeys = toSet(curation.featured_nft_keys);
  const preparedNfts = snapshot.nfts
    .map(prepareNft)
    .map((nft) => ({
      ...nft,
      featured: nft.featured || hasAnyAlias(nft.aliases, featuredNftKeys)
    }))
    .filter(
      (nft) =>
        !nft.hidden &&
        !hasAnyAlias(nft.aliases, hiddenNftKeys) &&
        !nft.collectionAliases.some((alias) => hiddenCollectionKeys.has(alias))
    );
  const collectionGroups = new Map<string, PreparedNft[]>();
  preparedNfts.forEach((nft) => {
    const collectionNfts = collectionGroups.get(nft.collectionKey) ?? [];
    collectionNfts.push(nft);
    collectionGroups.set(nft.collectionKey, collectionNfts);
  });
  const collectionSlugReservation = new Set<string>();
  const collectionEntries = Array.from(collectionGroups.entries()).sort(
    ([leftKey], [rightKey]) => compareStrings(leftKey, rightKey)
  );
  const featuredCollectionKeys = toSet(curation.featured_collection_keys);
  const collections = collectionEntries.map(([collectionKey, nfts]) => {
    const firstNft = nfts[0];
    const baseSlug = toProfileCmsGalleryRouteSlug(
      firstNft.collectionAliases[1] ?? firstNft.collectionTitle,
      'collection'
    );
    const slug = reserveSlug(baseSlug, collectionSlugReservation, [
      collectionKeySuffix(collectionKey)
    ]);
    const sortedNfts = sortNftsForCollection(nfts, collectionKey, curation);
    return {
      key: collectionKey,
      aliases: firstNft.collectionAliases,
      title: firstNft.collectionTitle,
      description: firstNft.collectionDescription,
      hidden: false,
      featured:
        firstNft.collectionAliases.some((alias) =>
          featuredCollectionKeys.has(alias)
        ) || nfts.some((nft) => nft.featured),
      order: getFirstDefinedNumber(nfts.map((nft) => nft.collectionOrder)),
      nfts: sortedNfts,
      slug,
      pageId: `collection-${slug}`,
      path: `/${snapshot.profile.handle}/collections/${slug}/index.html`
    };
  });
  const sortedCollections = sortCollections(collections, curation);
  const sortedNfts: PreparedNft[] = [];
  sortedCollections.forEach((collection) => {
    sortedNfts.push(...collection.nfts);
  });

  return { collections: sortedCollections, nfts: sortedNfts };
}

function prepareNft(nft: ProfileCmsGallerySnapshotNft): PreparedNft {
  const nftKey = nft.key ?? toProfileCmsGalleryNftKey(nft);
  const tokenId = normalizeTokenId(nft.token_id);
  const contract = normalizeEthereumAddress(nft.contract);
  const collectionTitle = nonEmptyText(nft.collection?.name, 'Collected NFTs');
  const collectionKey =
    nft.collection?.key ??
    `${nft.chain_id}:${contract}:${
      nft.collection?.id ??
      nft.collection?.slug ??
      toProfileCmsGalleryRouteSlug(collectionTitle)
    }`;
  const collectionAliases = uniqueStrings([
    collectionKey,
    nft.collection?.id,
    nft.collection?.slug,
    toProfileCmsGalleryRouteSlug(collectionTitle),
    collectionTitle
  ]);

  return {
    key: nftKey,
    aliases: uniqueStrings([
      nftKey,
      nft.id,
      `${contract}:${tokenId}`,
      `${nft.chain_id}:${contract}:${tokenId}`
    ]),
    chainId: nft.chain_id,
    contract,
    tokenId,
    title: nonEmptyText(nft.name, `${collectionTitle} #${tokenId}`),
    description: nft.description ?? '',
    collectionKey,
    collectionAliases,
    collectionTitle,
    collectionDescription: nft.collection?.description ?? '',
    media: nft.media,
    hidden: nft.hidden === true || nft.collection?.hidden === true,
    featured: nft.featured === true || nft.collection?.featured === true,
    order: nft.order,
    collectionOrder: nft.collection?.order
  };
}

function prepareNftPages(
  handle: string,
  nfts: readonly PreparedNft[]
): Map<string, PreparedNftPage> {
  const slugReservation = new Set<string>();
  const pagesByNftKey = new Map<string, PreparedNftPage>();
  nfts.forEach((nft) => {
    const baseSlug = toProfileCmsGalleryRouteSlug(
      `${nft.title}-${nft.tokenId}`,
      `token-${nft.tokenId}`
    );
    const slug = reserveSlug(baseSlug, slugReservation, [
      toProfileCmsGalleryRouteSlug(nft.contract.slice(-8), 'contract')
    ]);
    pagesByNftKey.set(nft.key, {
      nft,
      slug,
      pageId: `nft-${slug}`,
      path: `/${handle}/nfts/${slug}/index.html`
    });
  });
  return pagesByNftKey;
}

function sortCollections(
  collections: readonly PreparedCollection[],
  curation: ProfileCmsGalleryCurationInput
): PreparedCollection[] {
  const order = toOrderMap(curation.collection_order);
  const featured = toSet(curation.featured_collection_keys);
  return [...collections].sort((left, right) => {
    const explicit = compareOrder(
      getAliasOrder(left.aliases, order),
      getAliasOrder(right.aliases, order)
    );
    if (explicit !== 0) {
      return explicit;
    }
    const inputOrder = compareOrder(left.order, right.order);
    if (inputOrder !== 0) {
      return inputOrder;
    }
    const featuredCompare = compareBoolean(
      left.featured || hasAnyAlias(left.aliases, featured),
      right.featured || hasAnyAlias(right.aliases, featured)
    );
    if (featuredCompare !== 0) {
      return featuredCompare;
    }
    return compareStrings(left.key, right.key);
  });
}

function sortNftsForCollection(
  nfts: readonly PreparedNft[],
  collectionKey: string,
  curation: ProfileCmsGalleryCurationInput
): PreparedNft[] {
  const globalOrder = toOrderMap(curation.nft_order);
  const collectionOrder = toOrderMap(
    curation.collection_nft_order?.[collectionKey] ?? []
  );
  const featured = toSet(curation.featured_nft_keys);
  return [...nfts].sort((left, right) => {
    const collectionExplicit = compareOrder(
      getAliasOrder(left.aliases, collectionOrder),
      getAliasOrder(right.aliases, collectionOrder)
    );
    if (collectionExplicit !== 0) {
      return collectionExplicit;
    }
    const globalExplicit = compareOrder(
      getAliasOrder(left.aliases, globalOrder),
      getAliasOrder(right.aliases, globalOrder)
    );
    if (globalExplicit !== 0) {
      return globalExplicit;
    }
    const inputOrder = compareOrder(left.order, right.order);
    if (inputOrder !== 0) {
      return inputOrder;
    }
    const featuredCompare = compareBoolean(
      left.featured || hasAnyAlias(left.aliases, featured),
      right.featured || hasAnyAlias(right.aliases, featured)
    );
    if (featuredCompare !== 0) {
      return featuredCompare;
    }
    const contractCompare = compareStrings(left.contract, right.contract);
    if (contractCompare !== 0) {
      return contractCompare;
    }
    return compareTokenIds(left.tokenId, right.tokenId);
  });
}

function generateMediaForNft(
  nft: PreparedNft,
  pageSlug: string
): GeneratedMedia {
  const inputAssets = nft.media?.assets ?? [];
  const assetsByInputKey = new Map<string, CmsAssetV1>();
  const assets: CmsAssetV1[] = [];

  inputAssets.forEach((asset, index) => {
    const normalized = normalizeMediaAsset(asset, pageSlug, index, nft.title);
    if (!normalized) {
      return;
    }
    assets.push(normalized);
    assetsByInputKey.set(asset.key ?? String(index), normalized);
  });

  if (!nft.media) {
    return { assets };
  }

  const variants = (nft.media.display_variants ?? [])
    .map((variant) => toDisplayVariant(variant, assetsByInputKey))
    .filter(
      (
        variant
      ): variant is NonNullable<
        CmsPackageV1['payload']['nft_media_profiles']
      >[number]['display_variants'][number] => !!variant
    );
  const originalAssetIds = assets
    .filter((asset) => asset.roles?.includes('original'))
    .map((asset) => asset.id);
  const posterAssetId = getAssetIdForInputKey(
    nft.media.poster_asset_key,
    assetsByInputKey
  );
  const profile: NonNullable<
    CmsPackageV1['payload']['nft_media_profiles']
  >[number] = {
    id: `media-${pageSlug}`,
    chain_id: nft.chainId,
    contract: nft.contract,
    token_id: nft.tokenId,
    ...(nft.media.metadata_uri ? { metadata_uri: nft.media.metadata_uri } : {}),
    ...(nft.media.metadata_hash
      ? { metadata_hash: nft.media.metadata_hash }
      : {}),
    ...(originalAssetIds.length > 0
      ? { original_asset_ids: originalAssetIds }
      : {}),
    display_variants: variants,
    ...(posterAssetId ? { poster_asset_id: posterAssetId } : {})
  };
  const socialAsset = findAssetForRole(assets, 'social');
  const primaryAsset = findAssetForRole(assets, 'detail') ?? assets[0];

  return {
    assets,
    profile,
    primaryAssetId: primaryAsset?.id,
    socialAssetId: socialAsset?.id
  };
}

function normalizeMediaAsset(
  input: ProfileCmsGalleryMediaAssetInput,
  pageSlug: string,
  index: number,
  nftTitle: string
): CmsAssetV1 | null {
  const kind = input.kind ?? guessAssetKind(input.mime_type);
  if (requiresDimensions(kind) && (!input.width || !input.height)) {
    return null;
  }
  const roles = input.roles ?? [];
  const roleSuffix = roles[0] ?? `asset-${index + 1}`;
  return {
    id: `asset-${pageSlug}-${toProfileCmsGalleryRouteSlug(roleSuffix)}-${
      index + 1
    }`,
    kind,
    uri: input.uri,
    content_hash: input.content_hash,
    mime_type: input.mime_type,
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
    ...(input.duration_seconds !== undefined
      ? { duration_seconds: input.duration_seconds }
      : {}),
    ...(input.file_size_bytes !== undefined
      ? { file_size_bytes: input.file_size_bytes }
      : {}),
    ...(roles.length > 0 ? { roles: [...roles] } : {}),
    alt_text: input.alt_text ?? nftTitle,
    ...(input.decorative !== undefined ? { decorative: input.decorative } : {}),
    ...(input.rights ? { rights: input.rights } : {})
  };
}

function toDisplayVariant(
  input: ProfileCmsGalleryDisplayVariantInput,
  assetsByInputKey: ReadonlyMap<string, CmsAssetV1>
):
  | NonNullable<
      CmsPackageV1['payload']['nft_media_profiles']
    >[number]['display_variants'][number]
  | null {
  const assetId = getAssetIdForInputKey(input.asset_key, assetsByInputKey);
  if (!assetId) {
    return null;
  }
  const sourceAssetId = getAssetIdForInputKey(
    input.source_asset_key,
    assetsByInputKey
  );
  return {
    asset_id: assetId,
    role: input.role,
    ...(input.crop_mode ? { crop_mode: input.crop_mode } : {}),
    ...(input.background ? { background: input.background } : {}),
    ...(sourceAssetId ? { source_asset_id: sourceAssetId } : {})
  };
}

function buildHomePage({
  snapshot,
  collections,
  nftPages,
  mediaByNftKey,
  canonicalBaseUrl,
  siteTitle,
  siteDescription
}: {
  readonly snapshot: ProfileCmsGalleryWalletSnapshot;
  readonly collections: readonly PreparedCollection[];
  readonly nftPages: ReadonlyMap<string, PreparedNftPage>;
  readonly mediaByNftKey: ReadonlyMap<string, GeneratedMedia>;
  readonly canonicalBaseUrl: string;
  readonly siteTitle: string;
  readonly siteDescription: string;
}): CmsPageV1 {
  const visibleNfts: PreparedNft[] = [];
  collections.forEach((collection) => {
    visibleNfts.push(...collection.nfts);
  });
  const featuredPageIds = visibleNfts
    .filter((nft) => nft.featured)
    .map((nft) => nftPages.get(nft.key)?.pageId)
    .filter((pageId): pageId is string => !!pageId);
  const allPageIds = visibleNfts
    .map((nft) => nftPages.get(nft.key)?.pageId)
    .filter((pageId): pageId is string => !!pageId);
  const path = `/${snapshot.profile.handle}/index.html`;

  return {
    id: 'home-page',
    type: 'gallery',
    path,
    metadata: {
      title: truncateText(siteTitle, 160),
      description: truncateText(siteDescription, 300),
      locale: 'en-US',
      canonical_url: joinCanonicalUrl(canonicalBaseUrl, path),
      navigation_label: 'Gallery',
      ...(getFirstSocialAssetId(visibleNfts, mediaByNftKey)
        ? {
            social_image_asset_id: getFirstSocialAssetId(
              visibleNfts,
              mediaByNftKey
            )
          }
        : {})
    },
    source: { source_packet_id: 'wallet-snapshot' },
    blocks: [
      headingBlock('home-heading', siteTitle, 1),
      richTextBlock('home-summary', siteDescription),
      {
        id: 'home-wallet-gallery',
        block_type: 'generated_wallet_gallery',
        collection_count: collections.length,
        nft_count: visibleNfts.length,
        page_ids: allPageIds,
        featured_page_ids:
          featuredPageIds.length > 0 ? featuredPageIds : allPageIds
      } as CmsBlockV1
    ]
  };
}

function buildCollectionsIndexPage({
  handle,
  collections,
  canonicalBaseUrl,
  siteTitle,
  socialImageAssetId
}: {
  readonly handle: string;
  readonly collections: readonly PreparedCollection[];
  readonly canonicalBaseUrl: string;
  readonly siteTitle: string;
  readonly socialImageAssetId?: string;
}): CmsPageV1 {
  const path = `/${handle}/collections/index.html`;
  return {
    id: 'collections-index',
    type: 'collection',
    path,
    metadata: {
      title: truncateText(`${siteTitle} Collections`, 160),
      description: truncateText(`Collections in ${siteTitle}.`, 300),
      locale: 'en-US',
      canonical_url: joinCanonicalUrl(canonicalBaseUrl, path),
      navigation_label: 'Collections',
      ...(socialImageAssetId
        ? { social_image_asset_id: socialImageAssetId }
        : {})
    },
    source: { source_packet_id: 'wallet-snapshot' },
    blocks: [
      headingBlock('collections-heading', 'Collections', 1),
      {
        id: 'collections-list',
        block_type: 'collection_reference',
        collection_count: collections.length,
        page_ids: collections.map((collection) => collection.pageId),
        featured_page_ids: collections
          .filter((collection) => collection.featured)
          .map((collection) => collection.pageId)
      } as CmsBlockV1
    ]
  };
}

function buildCollectionPage({
  collection,
  nftPages,
  mediaByNftKey,
  canonicalBaseUrl
}: {
  readonly collection: PreparedCollection;
  readonly nftPages: ReadonlyMap<string, PreparedNftPage>;
  readonly mediaByNftKey: ReadonlyMap<string, GeneratedMedia>;
  readonly canonicalBaseUrl: string;
}): CmsPageV1 {
  const nftPageIds = collection.nfts
    .map((nft) => nftPages.get(nft.key)?.pageId)
    .filter((pageId): pageId is string => !!pageId);
  const assetIds = collection.nfts
    .map((nft) => mediaByNftKey.get(nft.key)?.primaryAssetId)
    .filter((assetId): assetId is string => !!assetId);
  const socialImageAssetId = getFirstSocialAssetId(
    collection.nfts,
    mediaByNftKey
  );

  return {
    id: collection.pageId,
    type: 'collection',
    path: collection.path,
    metadata: {
      title: truncateText(collection.title, 160),
      description: truncateText(
        collection.description ||
          `${collection.nfts.length} collected NFT${
            collection.nfts.length === 1 ? '' : 's'
          }.`,
        300
      ),
      locale: 'en-US',
      canonical_url: joinCanonicalUrl(canonicalBaseUrl, collection.path),
      navigation_label: truncateText(collection.title, 80),
      ...(socialImageAssetId
        ? { social_image_asset_id: socialImageAssetId }
        : {})
    },
    source: { source_packet_id: 'wallet-snapshot' },
    blocks: [
      headingBlock(`${collection.pageId}-heading`, collection.title, 1),
      ...(collection.description
        ? [
            richTextBlock(
              `${collection.pageId}-summary`,
              collection.description
            )
          ]
        : []),
      {
        id: `${collection.pageId}-gallery`,
        block_type: 'lightbox_gallery',
        page_ids: nftPageIds,
        asset_ids: assetIds,
        collection_key: collection.key
      } as CmsBlockV1
    ]
  };
}

function buildNftDetailPage({
  page,
  media,
  canonicalBaseUrl
}: {
  readonly page: PreparedNftPage;
  readonly media?: GeneratedMedia;
  readonly canonicalBaseUrl: string;
}): CmsPageV1 {
  const blocks: CmsBlockV1[] = [
    headingBlock(`${page.pageId}-heading`, page.nft.title, 1)
  ];
  if (media?.primaryAssetId) {
    blocks.push({
      id: `${page.pageId}-media`,
      block_type: 'image',
      asset_id: media.primaryAssetId,
      caption: page.nft.title
    } as CmsBlockV1);
  }
  if (page.nft.description) {
    blocks.push(
      richTextBlock(`${page.pageId}-description`, page.nft.description)
    );
  }
  blocks.push({
    id: `${page.pageId}-reference`,
    block_type: 'nft_reference',
    chain_id: page.nft.chainId,
    contract: page.nft.contract,
    token_id: page.nft.tokenId,
    title: page.nft.title,
    collection_title: page.nft.collectionTitle,
    ...(media?.profile ? { nft_media_profile_id: media.profile.id } : {})
  } as CmsBlockV1);

  return {
    id: page.pageId,
    type: 'nft_detail',
    path: page.path,
    metadata: {
      title: truncateText(page.nft.title, 160),
      description: truncateText(
        page.nft.description ||
          `${page.nft.collectionTitle} token ${page.nft.tokenId}.`,
        300
      ),
      locale: 'en-US',
      canonical_url: joinCanonicalUrl(canonicalBaseUrl, page.path),
      navigation_label: truncateText(page.nft.title, 80),
      ...(media?.socialAssetId
        ? { social_image_asset_id: media.socialAssetId }
        : {})
    },
    source: { source_packet_id: 'wallet-snapshot' },
    blocks
  };
}

function buildWalletSourcePacket(
  snapshot: ProfileCmsGalleryWalletSnapshot,
  capturedAt: string
): NonNullable<CmsPackageV1['payload']['source_packets']>[number] {
  const packet: Record<string, unknown> = {
    id: 'wallet-snapshot',
    source_type: 'wallet',
    captured_at: capturedAt,
    ...(snapshot.owner ? { owner: snapshot.owner } : {}),
    ...(snapshot.wallets ? { wallets: [...snapshot.wallets] } : {}),
    ...(snapshot.block_number !== undefined
      ? { block_number: snapshot.block_number }
      : {}),
    nft_count: snapshot.nfts.length
  };
  return packet as NonNullable<
    CmsPackageV1['payload']['source_packets']
  >[number];
}

function headingBlock(id: string, text: string, level: number): CmsBlockV1 {
  return { id, block_type: 'heading', text, level } as CmsBlockV1;
}

function richTextBlock(id: string, content: string): CmsBlockV1 {
  return { id, block_type: 'rich_text', content } as CmsBlockV1;
}

function createFixtureGallerySignature(signedAt: string): CmsSignatureV1 {
  return {
    type: 'fixture',
    signer: 'fixture',
    signature: 'fixture',
    signed_at: signedAt
  };
}

function createFixtureGalleryStorageReceipt(
  recordedAt: string
): CmsStorageReceiptV1 {
  return {
    provider: 'fixture',
    uri: 'https://fixtures.6529.io/profile-cms/gallery-package.json',
    content_hash: PROFILE_CMS_GALLERY_FIXTURE_ZERO_HASH,
    provider_content_id: 'profile-cms-gallery-fixture',
    pinned: false,
    canonical: true,
    recorded_at: recordedAt
  };
}

function withPackageHashStorageReceipts(
  cmsPackage: CmsPackageV1,
  providerToFill: CmsStorageReceiptV1['provider'] | undefined
): CmsPackageV1 {
  if (!providerToFill) {
    return cmsPackage;
  }
  return {
    ...cmsPackage,
    storage: cmsPackage.storage.map((receipt) =>
      receipt.provider === providerToFill
        ? {
            ...receipt,
            content_hash: cmsPackage.integrity.package_hash
          }
        : receipt
    )
  };
}

function createFixtureMediaAsset({
  key,
  uri,
  role,
  kind = 'image',
  width,
  height
}: {
  readonly key: string;
  readonly uri: string;
  readonly role: CmsAssetRole;
  readonly kind?: CmsAssetKind;
  readonly width: number;
  readonly height: number;
}): ProfileCmsGalleryMediaAssetInput {
  return {
    key,
    uri,
    kind,
    content_hash: hashFixtureString(uri),
    mime_type: kind === 'social_image' || kind === 'image' ? 'image/png' : kind,
    width,
    height,
    roles: [role]
  };
}

function hashFixtureString(value: string): string {
  return toCmsSha256Hash(`fixture:${value}`);
}

function getSiteTitle(
  snapshot: ProfileCmsGalleryWalletSnapshot,
  site?: ProfileCmsGallerySiteInput
): string {
  return nonEmptyText(
    site?.title ?? snapshot.profile.display_name,
    `${snapshot.profile.handle} Gallery`
  );
}

function getSiteDescription(
  snapshot: ProfileCmsGalleryWalletSnapshot,
  site?: ProfileCmsGallerySiteInput
): string {
  return (
    site?.description ??
    snapshot.profile.description ??
    `${snapshot.profile.handle}'s collected NFT gallery.`
  );
}

function getFirstSocialAssetId(
  nfts: readonly PreparedNft[],
  mediaByNftKey: ReadonlyMap<string, GeneratedMedia>
): string | undefined {
  for (const nft of nfts) {
    const socialAssetId = mediaByNftKey.get(nft.key)?.socialAssetId;
    if (socialAssetId) {
      return socialAssetId;
    }
  }
  return undefined;
}

function findAssetForRole(
  assets: readonly CmsAssetV1[],
  role: CmsAssetRole
): CmsAssetV1 | undefined {
  return (
    assets.find((asset) => asset.roles?.includes(role)) ??
    (role === 'social'
      ? assets.find((asset) => asset.kind === 'social_image')
      : undefined)
  );
}

function getAssetIdForInputKey(
  inputKey: string | undefined,
  assetsByInputKey: ReadonlyMap<string, CmsAssetV1>
): string | undefined {
  if (!inputKey) {
    return undefined;
  }
  return assetsByInputKey.get(inputKey)?.id;
}

function guessAssetKind(mimeType: string): CmsAssetKind {
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('model/')) {
    return 'model';
  }
  return 'image';
}

function requiresDimensions(kind: CmsAssetKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'social_image';
}

function reserveSlug(
  baseSlug: string,
  reserved: Set<string>,
  suffixCandidates: readonly string[]
): string {
  if (!reserved.has(baseSlug)) {
    reserved.add(baseSlug);
    return baseSlug;
  }
  for (const suffix of suffixCandidates) {
    const candidate = `${baseSlug}-${suffix}`;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
  let index = 2;
  while (reserved.has(`${baseSlug}-${index}`)) {
    index++;
  }
  const candidate = `${baseSlug}-${index}`;
  reserved.add(candidate);
  return candidate;
}

function collectionKeySuffix(collectionKey: string): string {
  return toProfileCmsGalleryRouteSlug(collectionKey.split(':').join('-'));
}

function normalizeEthereumAddress(address: string): string {
  return address.toLowerCase();
}

function normalizeTokenId(tokenId: string | number): string {
  return String(tokenId).trim();
}

function toSet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(values ?? []);
}

function toOrderMap(
  values: readonly string[] | undefined
): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  (values ?? []).forEach((value, index) => {
    if (!order.has(value)) {
      order.set(value, index);
    }
  });
  return order;
}

function getAliasOrder(
  aliases: readonly string[],
  order: ReadonlyMap<string, number>
): number | undefined {
  for (const alias of aliases) {
    const aliasOrder = order.get(alias);
    if (aliasOrder !== undefined) {
      return aliasOrder;
    }
  }
  return undefined;
}

function hasAnyAlias(
  aliases: readonly string[],
  values: ReadonlySet<string>
): boolean {
  return aliases.some((alias) => values.has(alias));
}

function uniqueStrings(
  values: readonly (string | undefined)[]
): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  values.forEach((value) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    unique.push(value);
  });
  return unique;
}

function getFirstDefinedNumber(
  values: readonly (number | undefined)[]
): number | undefined {
  return values.find((value): value is number => value !== undefined);
}

function compareOrder(
  left: number | undefined,
  right: number | undefined
): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

function compareBoolean(left: boolean, right: boolean): number {
  if (left === right) {
    return 0;
  }
  return left ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareTokenIds(left: string, right: string): number {
  const normalizedLeft = stripLeadingZeroes(left);
  const normalizedRight = stripLeadingZeroes(right);
  if (isIntegerString(normalizedLeft) && isIntegerString(normalizedRight)) {
    const lengthCompare = normalizedLeft.length - normalizedRight.length;
    if (lengthCompare !== 0) {
      return lengthCompare;
    }
  }
  return normalizedLeft.localeCompare(normalizedRight);
}

function stripLeadingZeroes(value: string): string {
  const stripped = value.replace(/^0+/, '');
  return stripped || '0';
}

function isIntegerString(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function joinCanonicalUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return `${trimmedBase}${path}`;
}

function nonEmptyText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
