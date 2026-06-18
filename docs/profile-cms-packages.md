# Profile CMS Packages

The backend profile CMS package service stores and publishes executable CMS V1
packages for profile-native sites. The CMS schema, canonicalization, and hash
rules are owned by the frontend protocol package in
`lib/profile-cms/protocol/v1`; the backend has a local parity port and protocol
test vectors for canonical JSON, payload hash, package hash, and package hash
exclusions.

## Public Primary Lookup

Frontend `/handle/index.html` integration should use:

```http
GET /api/profile-cms/:handle/primary
```

The frontend API client path is:

```text
profile-cms/{handle}/primary
```

Success response:

```json
{
  "package": {},
  "package_id": "profile-native-home",
  "version": 1,
  "package_hash": "sha256:...",
  "payload_hash": "sha256:...",
  "updated_at": 1792345678000,
  "published_at": 1792345678000
}
```

The endpoint returns 404 when the profile has no primary published CMS package.
It also returns 404 instead of serving draft, failed, superseded, archived, or
fixture-backed packages. Treat this endpoint as mutable and short-cache only.

## Private Package Operations

Private endpoints are OpenAPI-backed and mounted under `/api/profile-cms`:

- `POST /profile-cms/packages` saves a draft package for a profile.
- `POST /profile-cms/packages/validate` validates a package against CMS V1.
- `POST /profile-cms/packages/{id}/publish` validates, verifies storage and
  signature intent, and publishes a draft.
- `POST /profile-cms/packages/{id}/rollback` sets an earlier published or
  superseded production-safe package as primary with an expected-current guard.
- `POST /profile-cms/packages/{id}/archive` archives a non-primary package.
- `GET /profile-cms/packages/{id}/export` returns the package, storage receipts,
  and pointer events for mirror/renderer inspection.
- `GET /profile-cms/profiles/{profile_id}/packages` lists packages for a profile.
- `GET /profile-cms/packages/{id}` fetches by database id.
- `GET /profile-cms/profiles/{profile_id}/packages/{package_id}/versions/{version}` fetches by protocol package id and version.
- `GET /profile-cms/packages/by-hash/{package_hash}` fetches by package hash.

Owners can manage their own profile packages. Delegated publishers can manage a
profile when acting as that profile with the `PUBLISH_CMS` proxy action.
Anonymous users can fetch only production-safe published packages.

## Wallet Gallery Snapshot Contract

Profile CMS gallery generation can request a bounded snapshot of indexed wallet
holdings:

```http
POST /api/profile-cms/wallet-gallery/snapshot
```

This endpoint is authenticated and gated by
`FEATURE_PROFILE_CMS_WALLET_GALLERY=true` while the frontend generator contract
is being integrated. It reads the current backend NFT ownership index; it does
not live-index wallets, enqueue chain work, or change CMS package hash/signing
semantics.

Request shape:

```json
{
  "wallets": ["0x...", "name.eth"],
  "exclude_contracts": ["0x..."],
  "exclude_assets": [{ "contract": "0x...", "token_id": 1 }],
  "include_spam": false,
  "max_assets": 200
}
```

Frontend integration notes:

- `wallets` accepts Ethereum addresses and `.eth` ENS names. Addresses are
  normalized through `ethers.getAddress(...).toLowerCase()`. ENS names are
  resolved only from the backend `ens` table for deterministic MVP snapshots.
- The snapshot source is always `indexed_ownership`; `block_reference` is the
  highest `nft_owners.block_reference` represented by indexed rows in the
  response.
- `assets` are visible rows after request-side exclusions and `max_assets`.
  Rows are sorted deterministically by collection order, contract, token id,
  then owner wallet.
- `excluded_assets` reports request-side exclusions with
  `contract_excluded` or `asset_excluded` so the generator can preserve audit
  context without rendering those assets.
- Asset `media` normalizes image, preview, thumbnail, animation, animation
  preview, and inferred MIME fields across MEMES, Meme Lab, Gradients, and
  NextGen.
- Asset `flags.spam` is currently always `false`; `include_spam` is reserved
  for a later indexed spam/unwanted flag source.

## Publish Rules

Publish runs CMS V1 validation with production options:

- Hash enforcement is enabled for payload and package hashes.
- Fixture signatures are rejected.
- Fixture storage receipts are rejected.
- At least one IPFS or Arweave receipt is required for production publish.
- Only draft packages can be published.
- Publishing a package marks it primary and supersedes the previous primary
  package for that profile.
- Publishing requires a canonical decentralized storage receipt and an EIP-712
  publish signature by a wallet in the target profile.

The package hash intentionally excludes signatures, storage receipts, and the
`integrity.package_hash` field itself. Public by-hash and primary reads still
filter for published production-safe rows so fixture packages are not served
even if they share a package hash with a later production package.

The publish request body extends the expected hash guard with signing intent:

```json
{
  "expected_package_hash": "sha256:...",
  "expected_payload_hash": "sha256:...",
  "signer_address": "0x...",
  "signature": "0x...",
  "chain_id": 1,
  "deadline": 1792345678000,
  "is_safe_signature": false,
  "verifying_contract": null
}
```

`deadline` is Unix epoch milliseconds and must be in the future when the server
publishes. The server caps deadlines to 15 minutes from receipt, so CMS publish
intents are short-lived. `verifying_contract` is optional and becomes the
EIP-712 domain `verifyingContract` when supplied.

## Publish Signature

The exact EIP-712 domain is:

```json
{
  "name": "6529 Profile CMS",
  "version": "1",
  "chainId": 1,
  "verifyingContract": "0x..."
}
```

`verifyingContract` is omitted when the request does not provide one. The exact
primary type is `ProfileCmsPublish`:

| Field | Type | Meaning |
|---|---|---|
| `action` | `string` | Literal `publish`; prevents signature reuse across future actions. |
| `profileId` | `string` | Target profile id. |
| `handle` | `string` | Live profile handle resolved by the backend. |
| `packageId` | `string` | CMS package protocol id. |
| `version` | `uint256` | CMS package version. |
| `draftId` | `string` | Backend package row id being published. |
| `payloadHash` | `string` | CMS V1 payload hash. |
| `packageHash` | `string` | CMS V1 package hash. |
| `primaryPath` | `string` | Expected public path, e.g. `/handle/index.html`. |
| `storageProvider` | `string` | Canonical decentralized receipt provider. |
| `storageUri` | `string` | Canonical decentralized receipt URI. |
| `storageContentHash` | `string` | Canonical receipt content hash. |
| `deadline` | `uint256` | Epoch-millis replay window end. |

EOA signatures are recovered server-side and must match `signer_address` and a
wallet consolidated into the target profile. Safe/EIP-1271 signatures set
`is_safe_signature=true`; the backend first requires contract bytecode at
`signer_address` on the request `chain_id`, then calls
`isValidSignature(bytes32,bytes)` using the same repo RPC chain. Chain ids `1`,
`5`, and `11155111` are supported. Production Safe verification requires
`ALCHEMY_API_KEY` so the RPC provider can be constructed. Unsupported chains and
failed RPC checks fail closed.

Verified publish signatures are consumed by `typed_data_hash` in
`profile_cms_publish_signatures` inside the publish transaction before package
pointer mutations. That makes a valid publish intent single-use once it reaches
the state-changing path while avoiding signature burn on stale expected-hash
failures.

## Storage Receipt Indexing

`profile_cms_packages` stores the full package `storage` array and indexes one
selected receipt for later acceleration work:

- `storage_provider`
- `storage_uri`
- `storage_content_hash`
- `storage_provider_content_id`
- `storage_recorded_at`
- `storage_pinned`
- `storage_canonical`

The publish-time storage verifier requires exactly one canonical decentralized
receipt:

- IPFS canonical receipts must use native `ipfs://<cid>` URIs. The optional
  `provider_content_id` must match the CID.
- Arweave canonical receipts must use native `ar://<txid>` URIs. The optional
  `provider_content_id` must match the transaction id. Gateway URLs can be kept
  as non-canonical mirrors, but do not satisfy production publish.
- Canonical receipt `content_hash` must equal the CMS package hash.
- S3 and fixture receipts may be retained as non-canonical metadata, but they
  cannot satisfy production publish.

This verifier checks provider shape and package-hash consistency. It does not
fetch remote bytes from IPFS/Arweave yet; that remains a storage adapter
deployment concern for later acceleration and mirror work.

## Pointer Events And Export

`profile_cms_pointer_events` records `publish`, `set_primary`, `supersede`,
`rollback`, and `archive` events. Events include package ids, hashes, previous
primary row id when relevant, actor profile id, publish typed-data hash,
signature, canonical storage receipt, and an `event_sequence` that preserves
logical ordering for events written in the same millisecond. The log is
append-only enough to reconstruct primary pointer history for a profile.

Rollback requires `expected_current_package_id` and optionally
`expected_current_package_hash` so clients cannot accidentally move a stale
pointer. Only published or superseded production-safe packages can become
primary again.

The export endpoint returns the CMS package JSON, indexed hashes/version/status,
the stored receipt array, and pointer events. Public pointer metadata
intentionally includes `actor_profile_id`, `signer_address`, `typed_data_hash`,
and storage receipt data so mirrors can verify who moved the pointer and which
decentralized receipt was selected. The response intentionally omits raw
`signature` and full `typed_data`. It is intended for future standalone
renderers and mirrors; public access is limited to published production-safe
packages, with private rows still requiring profile CMS permissions.
