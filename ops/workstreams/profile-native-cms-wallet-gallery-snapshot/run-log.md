# Run Log

## 2026-06-18

- Created branch `codex/cms-wallet-nft-snapshot` from
  `codex/profile-cms-decentralized-publish` detached-head worktree state.
- Added wallet/ENS normalization for CMS gallery snapshots. Wallet addresses
  are normalized locally, and ENS names resolve from the indexed `ens` table.
- Added read-only snapshot repository over existing indexed NFT ownership and
  metadata tables: `nft_owners`, `ens`, `nfts`, `nfts_meme_lab`, and
  `nextgen_tokens`.
- Added media normalization for image, preview, thumbnail, animation,
  animation preview, and inferred MIME fields.
- Added authenticated OpenAPI-backed endpoint
  `POST /api/profile-cms/wallet-gallery/snapshot`, gated by
  `FEATURE_PROFILE_CMS_WALLET_GALLERY`.
- Added MVP unwanted/spam handling through request-side `exclude_contracts` and
  `exclude_assets`, reported in `excluded_assets`; indexed spam flags remain
  reserved and return zero/false.
- Regenerated OpenAPI models and generated routes after updating
  `src/api-serverless/openapi.yaml`.
- Updated frontend contract docs in `docs/profile-cms-packages.md` and API/DB
  architecture notes in `docs/architecture.md`.
- Focused validation passed:
  `node node_modules/jest/bin/jest.js src/profile-cms/wallet-gallery/wallet-gallery-address-normalizer.test.ts src/profile-cms/wallet-gallery/wallet-gallery-media-normalizer.test.ts src/profile-cms/wallet-gallery/wallet-gallery-snapshot-db.test.ts src/api-serverless/src/profile-cms/wallet-gallery-api-service.test.ts --runInBand`.
- Final validation passed:
  - `bash -lc "npm run lint"`
  - `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  - `node node_modules/jest/bin/jest.js src/profile-cms/wallet-gallery/wallet-gallery-address-normalizer.test.ts src/profile-cms/wallet-gallery/wallet-gallery-media-normalizer.test.ts src/profile-cms/wallet-gallery/wallet-gallery-snapshot-db.test.ts src/api-serverless/src/profile-cms/wallet-gallery-api-service.test.ts --runInBand`
  - `codex-diff-check`
- Opened PR #1650 targeting `codex/profile-cms-decentralized-publish`.
- Requested CodeRabbit review with `@coderabbitai review`; CodeRabbit reported
  org review rate limiting, so no inline CodeRabbit findings were available.
- Addressed Sonar maintainability findings; follow-up Sonar analysis reported
  zero new issues.
- Addressed 6529bot follow-up review:
  - NextGen snapshot ownership now reads from `nextgen_tokens.owner` and
    left-joins `nft_owners` only to enrich block reference/balance when present.
  - Verified against local indexed rows that sampled NextGen token ids
    `10000000000` through `10000000004` match `nft_owners.token_id` for the
    same owner wallet and have indexed block references.
  - Removed the dead wallet sentinel fallback in snapshot DB queries.
  - Made snapshot sorting resilient to unknown collection keys and skipped
    malformed indexed token ids instead of failing otherwise valid requests.
  - Added a comment clarifying that the ENS regex is a local lookup-format gate,
    not exhaustive ENS validation.
- Review-iteration validation passed:
  - `bash -lc "npm run lint"`
  - `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  - `node node_modules/jest/bin/jest.js src/profile-cms/wallet-gallery/wallet-gallery-address-normalizer.test.ts src/profile-cms/wallet-gallery/wallet-gallery-media-normalizer.test.ts src/profile-cms/wallet-gallery/wallet-gallery-snapshot-db.test.ts src/api-serverless/src/profile-cms/wallet-gallery-api-service.test.ts --runInBand`
  - `codex-diff-check`
