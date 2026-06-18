# Active Context

First file to read after compaction: this file.

## Goal

Phase 5 backend gallery package generator lane for profile-native CMS.

## Branch

`codex/cms-gallery-generator`, based on
`origin/codex/profile-cms-decentralized-publish`.

## Current State

- Library-only generator implemented under `src/profile-cms`.
- Generator accepts `ProfileCmsGalleryPackageGenerationInput` and returns a CMS
  V1 `CmsPackageV1`.
- Fixture snapshot fallback is available for FE preview work until the wallet
  snapshot service is ready.
- Dedicated docs describe the FE-facing contract and future
  `POST /api/profile-cms/packages/generate-gallery` boundary.

## Open Notes

- No API route is added in this PR.
- Production publish still requires replacing fixture signature/storage with
  EIP-712 signature and canonical IPFS/Arweave receipt.
- `npm ci --ignore-scripts` was needed locally because `serverless`
  postinstall failed after an interrupted install.

## Next Actions

- Run lint/typecheck checks.
- Update run log with final validation evidence.
- Commit, push, open PR, and request bot feedback.
