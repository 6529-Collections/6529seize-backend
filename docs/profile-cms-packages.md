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
- `POST /profile-cms/packages/{id}/publish` validates and publishes a draft.
- `GET /profile-cms/profiles/{profile_id}/packages` lists packages for a profile.
- `GET /profile-cms/packages/{id}` fetches by database id.
- `GET /profile-cms/profiles/{profile_id}/packages/{package_id}/versions/{version}` fetches by protocol package id and version.
- `GET /profile-cms/packages/by-hash/{package_hash}` fetches by package hash.

Owners can manage their own profile packages. Delegated publishers can manage a
profile when acting as that profile with the `PUBLISH_CMS` proxy action.
Anonymous users can fetch only production-safe published packages.

## Publish Rules

Publish runs CMS V1 validation with production options:

- Hash enforcement is enabled for payload and package hashes.
- Fixture signatures are rejected.
- Fixture storage receipts are rejected.
- At least one IPFS or Arweave receipt is required for production publish.
- Only draft packages can be published.
- Publishing a package marks it primary and supersedes the previous primary
  package for that profile.

The package hash intentionally excludes signatures, storage receipts, and the
`integrity.package_hash` field itself. Public by-hash and primary reads still
filter for published production-safe rows so fixture packages are not served
even if they share a package hash with a later production package.

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

The model supports content-addressed IPFS and Arweave receipts as canonical
storage, plus S3 acceleration receipts for later delivery work. S3 receipts are
not allowed to be canonical by CMS V1 validation.
