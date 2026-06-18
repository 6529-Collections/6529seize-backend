# Profile CMS Gallery Generator

The backend gallery generator is the durable wallet-snapshot to CMS V1 package
source of truth for profile-native gallery pages. The implementation lives in
`src/profile-cms/profile-cms-gallery-package-generator.ts` and exports:

```ts
generateProfileCmsGalleryPackage(
  input?: ProfileCmsGalleryPackageGenerationInput
): CmsPackageV1
```

It is library-only in this PR. It does not add an API route, persistence write,
or new CMS schema field. The generated object is a normal CMS V1 package and is
validated by the existing backend `validateCmsPackageV1` path.

## Snapshot Input Contract

`ProfileCmsGalleryPackageGenerationInput.snapshot` is the narrow adapter
contract expected from the wallet snapshot lane. If `snapshot` is omitted, the
generator uses a deterministic fixture snapshot so FE and BE can keep preview
work unblocked until the snapshot service is wired.

Required profile fields:

| Field                        | Required | Meaning                                                      |
| ---------------------------- | -------: | ------------------------------------------------------------ |
| `profile.handle`             |      yes | Profile handle. All generated paths live under `/{handle}/`. |
| `profile.profile_id`         |       no | Backend profile id copied into `package.profile.profile_id`. |
| `profile.primary_wallet`     |       no | Primary wallet copied into `package.profile.primary_wallet`. |
| `profile.display_name`       |       no | Preferred site title. Falls back to `{handle} Gallery`.      |
| `profile.description`        |       no | Preferred site/page description.                             |
| `profile.canonical_base_url` |       no | Canonical URL origin. Defaults to `https://6529.io`.         |

Snapshot metadata fields:

| Field          | Required | Meaning                                                        |
| -------------- | -------: | -------------------------------------------------------------- |
| `owner`        |       no | Snapshot owner wallet included in the wallet source packet.    |
| `wallets`      |       no | Consolidated wallet list included in the wallet source packet. |
| `block_number` |       no | Chain block height included in the wallet source packet.       |
| `captured_at`  |       no | ISO timestamp used for package provenance and source packet.   |
| `nfts`         |      yes | Normalized NFT records to render.                              |

NFT fields:

| Field         | Required | Meaning                                                              |
| ------------- | -------: | -------------------------------------------------------------------- |
| `key`         |       no | Stable curation key. Defaults to `{chain_id}:{contract}:{token_id}`. |
| `id`          |       no | Alias accepted by hide/feature/order controls.                       |
| `chain_id`    |      yes | Chain id for CMS NFT media profile and NFT reference blocks.         |
| `contract`    |      yes | Ethereum contract address. Normalized to lowercase.                  |
| `token_id`    |      yes | Token id rendered as a string.                                       |
| `name`        |       no | NFT title. Falls back to `{collection.name} #{token_id}`.            |
| `description` |       no | Detail-page description and rich text.                               |
| `collection`  |       no | Collection grouping metadata.                                        |
| `media`       |       no | Media assets, display variants, and metadata URI/hash.               |
| `hidden`      |       no | Item-level hide flag.                                                |
| `featured`    |       no | Item-level feature flag.                                             |
| `order`       |       no | Numeric item order before stable fallback sorting.                   |

Collection fields:

| Field         | Required | Meaning                                                      |
| ------------- | -------: | ------------------------------------------------------------ |
| `key`         |       no | Stable collection key. Defaults to chain/contract/name data. |
| `id`          |       no | Alias accepted by controls and preferred route-slug source.  |
| `slug`        |       no | Alias accepted by controls and preferred route-slug source.  |
| `name`        |      yes | Collection title.                                            |
| `description` |       no | Collection page summary.                                     |
| `artist`      |       no | Reserved for future renderer use.                            |
| `hidden`      |       no | Collection-level hide flag.                                  |
| `featured`    |       no | Collection-level feature flag.                               |
| `order`       |       no | Numeric collection order before stable fallback sorting.     |

Media fields:

| Field                      | Required | Meaning                                                    |
| -------------------------- | -------: | ---------------------------------------------------------- |
| `media.metadata_uri`       |       no | Safe metadata URI for the CMS NFT media profile.           |
| `media.metadata_hash`      |       no | CMS `sha256:` metadata hash.                               |
| `media.assets[]`           |       no | Asset records to copy into `payload.assets`.               |
| `media.display_variants[]` |       no | Role mapping into `nft_media_profiles[].display_variants`. |
| `media.poster_asset_key`   |       no | Asset key used as the media profile poster.                |

Each `media.assets[]` item needs `uri`, `content_hash`, and `mime_type`.
Image, video, and social-image assets also need `width` and `height`; otherwise
the generator skips that asset rather than inventing media dimensions. Asset
`roles` map directly to CMS V1 asset roles. Display variants reference assets
by `asset_key` and emit CMS `role`, `crop_mode`, `background`, and
`source_asset_id` where present.

## Curation Controls

`ProfileCmsGalleryPackageGenerationInput.curation` accepts:

| Field                      | Meaning                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `hidden_nft_keys`          | Removes matching NFTs by `key`, `id`, `{contract}:{token_id}`, or canonical NFT key. |
| `hidden_collection_keys`   | Removes matching collections by `key`, `id`, `slug`, generated slug, or title.       |
| `featured_nft_keys`        | Marks matching NFTs as featured on the gallery home page.                            |
| `featured_collection_keys` | Marks matching collections as featured on the collections index.                     |
| `nft_order`                | Global NFT ordering by NFT key/alias.                                                |
| `collection_order`         | Collection ordering by collection key/alias.                                         |
| `collection_nft_order`     | Per-collection NFT ordering keyed by canonical collection key.                       |

Sorting is deterministic. Explicit order wins, then numeric `order`, then
featured status, then stable collection/NFT keys.

## Generated Routes

The generator always emits:

- `/{handle}/index.html` gallery home page.
- `/{handle}/collections/index.html` collections index.
- `/{handle}/collections/{collection-slug}/index.html` for each visible collection.
- `/{handle}/nfts/{nft-slug}/index.html` for each visible NFT.

Route slugs are lowercase ASCII, collapse non-alphanumeric runs to `-`, and cap
at 72 characters before collision suffixing. Collection collisions receive a
stable suffix derived from the collection key. NFT collisions receive a stable
suffix derived from the contract tail and then a numeric fallback if needed.
Unit tests assert stable output from shuffled input and no route collisions.

## Generated CMS Package Shape

The package uses only existing CMS V1 fields:

- `payload.pages` for gallery home, collections index, collection pages, and NFT detail pages.
- `payload.routes` for one page route per page.
- `payload.assets` for complete media assets.
- `payload.nft_media_profiles` whenever NFT `media` exists; asset-backed
  display variants are included only when referenced assets are complete.
- `payload.navigation`, `payload.taxonomies`, `payload.source_packets`, and `payload.build_manifest`.
- `integrity.payload_hash` and `integrity.package_hash` computed with the existing CMS V1 hash helpers.

By default the generator adds fixture signature/storage receipts so offline and
preview callers can validate deterministically with:

```ts
validateCmsPackageV1(cmsPackage, {
  allowFixtureSignatures: true,
  allowFixtureStorage: true,
  enforceHashes: true
});
```

Production publish behavior is unchanged. Before calling the existing publish
path, callers must replace fixture signature/storage with a profile wallet
EIP-712 signature and a canonical IPFS or Arweave receipt whose
`content_hash` equals `integrity.package_hash`.

## Future API Boundary

The intended service boundary is:

```http
POST /api/profile-cms/packages/generate-gallery
```

Request body should be the same `ProfileCmsGalleryPackageGenerationInput`
contract documented above. Response should return:

```json
{
  "cms_package": {},
  "validation_result": {}
}
```

The endpoint should be side-effect free by default, running generation and CMS
validation only. A later save/publish flow can pass the generated package into
the existing `POST /profile-cms/packages` draft endpoint, preserving the current
CMS V1 package contract and storage/publish hardening.

Until that API exists, FE preview adapters can consume the documented snapshot
contract and compare their package output against the backend generator tests.
