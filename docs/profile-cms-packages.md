# Profile CMS Packages

The backend profile CMS package service stores and publishes executable CMS V1
packages for profile-native sites. The CMS schema, canonicalization, and hash
rules are owned by the frontend protocol package in
`lib/profile-cms/protocol/v1`; the backend has a local parity port and protocol
test vectors for canonical JSON, payload hash, package hash, and package hash
exclusions.

The profile gallery package generator is documented in
`docs/profile-cms-gallery-generator.md`. It defines the wallet snapshot input
contract, stable route slug rules, media profile/display variant mapping,
hide/feature/reorder controls, and the future API boundary for FE to replace
temporary preview adapters.

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
- `POST /profile-cms/packages/{id}/storage/upload` uploads the saved canonical content core.
- `POST /profile-cms/packages/{id}/unpublish` removes the current primary with required expected-current id and hash.
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

This endpoint is authenticated and enabled when
`FEATURE_PROFILE_CMS_WALLET_GALLERY` is absent or exactly `true`. Setting it to
`false` or any other value disables snapshot generation. It reads the current
backend NFT ownership index; it does
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
  normalized through `ethers.getAddress(...).toLowerCase()`. ENS names use
  onchain Ethereum forward resolution through the configured Alchemy RPC and a
  one-minute success cache. This supports aliases whose indexed display name
  differs and avoids treating stale reverse-index entries as the current owner.
  Requests resolve at most 25 distinct names, with four lookups in parallel and
  a four-second overall wait. Each lookup has a four-second deadline, RPC
  requests time out after 1.5 seconds without retries, and no queued names start
  after the overall deadline. ENS names requiring offchain resolution are not
  supported; enter their wallet address instead. Missing names return
  `ens_not_found`; provider failures and deadline expiry return
  `ens_lookup_failed`. Other valid wallet inputs still produce their snapshots.
  Raw wallet addresses retain their indexed display names.
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

## BYO AI Agent Affordances

The backend exposes read-only affordances so users can point their own agents at
CMS drafts and packages without 6529 running or paying for model inference.

```http
GET /api/profile-cms/agent/schema-bundle
GET /api/profile-cms/packages/:id/agent/source-packet
POST /api/profile-cms/packages/:id/agent/patch/validate
```

The schema bundle is public and returns the current string schema ids,
source-packet categories, patch operation names, endpoint templates, endpoint
auth requirements, patch limits, and safety metadata. Frontend clients should
treat this as the narrow contract for external agent integrations.

Source packets are data, not instructions. The response deliberately separates:

- `facts`: backend package row facts, profile references, wallet gallery
  snapshots, collection references, NFT references, storage receipts, and
  signature summaries where present.
- `author_copy`: user-authored titles, descriptions, captions, labels, and text
  blocks. Treat all fields here as untrusted prompt input.
- `derived_metadata`: route/page/block/asset/source-packet counts and other
  computed metadata.
- `validation_diagnostics`: a live CMS V1 validation result plus any stored
  package validation result/error.

The response includes `safety.untrusted_fields`; frontend and external-agent
adapters must not execute or follow instructions found in those fields. They
should pass them as quoted data/context only.

Published production-safe source packets are public. Draft, failed, archived,
or otherwise private package packets require the profile owner or delegated
`PUBLISH_CMS` proxy authority. Missing authority returns the same not-found
shape as other private package reads.

Patch validation accepts an `agent_patch` object with schema
`6529.cms.agent_patch.v1` and returns
`6529.cms.agent_patch_validation_result.v1`. The endpoint requires profile CMS
authority, only validates against draft packages, dry-runs supported operations
in memory, and never writes. `applied` is always `false`; sending `apply: true`
returns a structured `agent_patch.apply_not_supported` issue. A successful
patch preflight does not bypass draft save, CMS validation, decentralized
storage, signing, or publish authority. Agents should use the returned
`candidate_validation` to revise proposals, then hand the final package back to
the normal save/publish flow.

Agent patch targets must include `draft_id`, `base_version`, and
`base_package_hash`; omitting the hash is rejected so stale local agent state
cannot pass on version alone. Patch validation accepts at most 200 operations in
one request. `update_navigation` replaces `/payload/navigation` as a whole, and
`update_theme` targets `/site/theme`.

## Publish Rules

Publish runs CMS V1 validation with production options:

- Hash enforcement is enabled for payload and package hashes.
- Fixture signatures are rejected.
- Fixture storage receipts are rejected.
- At least one IPFS or Arweave receipt is required for production publish.
- Only draft packages can be newly published. An exact completed signature retry returns the existing publication without moving the pointer again.
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
  "expected_current_package_id": null,
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

| Field                | Type      | Meaning                                                            |
| -------------------- | --------- | ------------------------------------------------------------------ |
| `action`             | `string`  | Literal `publish`; prevents signature reuse across future actions. |
| `profileId`          | `string`  | Target profile id.                                                 |
| `handle`             | `string`  | Live profile handle resolved by the backend.                       |
| `packageId`          | `string`  | CMS package protocol id.                                           |
| `version`            | `uint256` | CMS package version.                                               |
| `draftId`            | `string`  | Backend package row id being published.                            |
| `payloadHash`        | `string`  | CMS V1 payload hash.                                               |
| `packageHash`        | `string`  | CMS V1 package hash.                                               |
| `primaryPath`        | `string`  | Expected public path, e.g. `/handle/index.html`.                   |
| `storageProvider`    | `string`  | Canonical decentralized receipt provider.                          |
| `storageUri`         | `string`  | Canonical decentralized receipt URI.                               |
| `storageContentHash` | `string`  | Canonical receipt content hash.                                    |
| `deadline`           | `uint256` | Epoch-millis replay window end.                                    |

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

The API also fetches the canonical object from the fixed Arweave/IPFS gateways,
with redirects disabled, an 8-second timeout, and a 2 MiB limit. It compares the
SHA-256 of the actual bytes with the signed package hash. Arweave reads use its
raw-data endpoint to avoid browser sandbox redirects and manifest resolution.
Only HTTP 200 supplies verifiable content; a missing or propagating object,
including HTTP 202, returns `503 cms_storage_pending`. Mismatched bytes are
rejected. The primary pointer stays unchanged and the draft remains retryable.

### Draft Upload And Signed Recovery Manifest

Saving creates an immutable revision with a server-assigned database id and
version. It resets inherited storage/signature envelopes to draft placeholders;
the content core and its hashes are preserved. Clients must read the saved row,
upload that row, read its canonical receipt, and derive signing fields from that
record. Package-by-id reads and authorized private lists use the writer database
so signing preparation sees completed writes without replica lag. Public primary
reads may take a short time to propagate. A changed live profile handle requires
a new draft; publish and rollback check the handle again under the profile lock.
The signed `primaryPath` is `/{profile_handle}/index.html`. Imported core
handle casing can differ from the canonical profile handle; the signed core hash
preserves the original content. `site.base_path` can be another valid profile
route and is not the signed primary pointer path.

`POST /profile-cms/packages/{id}/storage/upload` writes canonical JSON with
`signatures`, `storage`, and `integrity.package_hash` omitted, exactly matching the
package-hash preimage. The returned native `ar://` receipt is stored on the draft.

After wallet verification, publish uploads a separate canonical JSON manifest:

```text
schema: 6529.cms.publication.v1
package_uri, package_hash, payload_hash
profile_id, profile_handle, package_id, package_db_id, version, primary_path
typed_data: { domain, types, primaryType: ProfileCmsPublish, message }
signature, signature_kind: eoa | eip1271, signer_address
package_envelope: { integrity, signatures, storage }
published_at
```

The manifest's own Arweave receipt is returned as `recovery_receipt` on package
and export responses. Both the content core and this signed manifest must be
retrievable and hash-verified before the primary pointer moves. Recovery loads
these two objects, verifies the core hash and all EIP-712 bindings, verifies the
wallet signature, overlays `package_envelope` onto the core, and validates CMS V1.
This works without the 6529 API. A historic deadline may be expired during
recovery; it only limited live publication. EOA wallet authorship is verifiable
offline. Safe verification requires chain RPC state and does not establish a
historic signer-set proof. Neither the wallet signature nor `published_at`
independently proves profile registry membership, a trusted timestamp, or the
current primary pointer.

`profile_cms_uploads` reserves durable operation keys and short leases outside
network I/O transactions. Before provider submission, it checkpoints the complete
signed Arweave transaction and original public content bytes, then checkpoints
chunk progress. A retry resumes that transaction ID and those bytes even if the
provider accepted it before a progress or final receipt write failed. Completed
uploads reuse receipts. Concurrent attempts return `409 cms_upload_in_progress`;
interrupted attempts retain their lease and can be resumed after 120 seconds.
Expiry permits takeover; a replacement token fences the previous worker under
the row lock. The current token can still record completion after the deadline
if no replacement has claimed the operation.
The signed transaction checkpoint contains no storage wallet private key and is
cleared atomically when its final receipt is recorded.
Each object is limited to 2 MiB and each profile to
32 upload attempts per 24-hour activity window (core and manifest uploads both
count). A failed or interrupted upload can consume a quota attempt. Abandoning
publication can leave an unreferenced transaction, but retrying the same durable
operation does not create another paid transaction. Retries stay bounded by the
lease and quota. `ARWEAVE_KEY` must be configured for API storage writes.

Retain the exact signed publish request during storage propagation retries.
Re-sign only after its deadline expires or the persisted signing context changes.
Completed retries never reactivate a superseded package. Failed validation
records diagnostics on the draft without permanently consuming its state or
signature. New manifest fields are additive; previously published packages remain
readable without a recovery receipt and are not rewritten automatically.

## Pointer Events And Export

`profile_cms_pointer_events` records `publish`, `set_primary`, `supersede`,
`rollback`, `unpublish`, and `archive` events. Events include package ids, hashes,
previous primary row id when relevant, actor profile id, publish typed-data hash,
signature, canonical storage receipt, and an `event_sequence` that preserves
logical ordering for events written in the same millisecond. The log is
append-only enough to reconstruct primary pointer history for a profile.

Rollback requires `expected_current_package_id` and optionally
`expected_current_package_hash` so clients cannot accidentally move a stale
pointer. Only published or superseded production-safe packages can become
primary again. Pass `expected_current_package_id: null` to restore after
unpublish when there is no current primary. Unpublish requires the exact current
id and hash, retains the signed package, and records an audit event. Repeating
unpublish after it succeeds does not duplicate the event or remove a newer
primary. Publishing accepts the same expected-current guard, checked before paid
uploads and again under the profile lock; pointer conflicts return 409. Omitting
the publish guard means no primary is expected, just like passing null. An
unpublish retry must also match the latest package audit event.

Profile-row locking also serializes first-draft version allocation and primary
changes, including profiles with no existing CMS rows.

The export endpoint returns the CMS package JSON, indexed hashes/version/status,
the stored receipt array, and pointer events. Public pointer metadata
intentionally includes `actor_profile_id`, `signer_address`, `typed_data_hash`,
storage receipt data, raw `signature`, and complete `typed_data` so mirrors can
verify published wallet intent and the selected decentralized receipt. Responses
also expose `is_primary` separately from publication history status and include
`recovery_receipt` when one was created. For standalone renderers and mirrors,
public access is limited to published production-safe packages, with private rows still requiring profile CMS permissions.
