# Run Log

## 2026-06-17

- Started stacked CMS Decentralized Publish Spine branch
  `codex/profile-cms-decentralized-publish` from BE PR #1645 head
  `33c81546`, targeting `codex/profile-cms-backend`.
- Added publish EIP-712 helpers for `ProfileCmsPublish`, including exact domain
  and message fields, EOA recovery, deadline enforcement in the service, and an
  EIP-1271 verifier path backed by the repo RPC provider for mainnet, Goerli,
  and Sepolia.
- Added production storage receipt validation for canonical decentralized
  receipts: exactly one canonical IPFS or Arweave receipt, package-hash
  `content_hash` consistency, native/provider id checks, and S3/fixture-only
  rejection for publish.
- Added profile CMS pointer event persistence:
  `profile_cms_pointer_events` entity, table constant, explicit migration SQL,
  repository, and publish/set-primary/supersede/rollback/archive event writes.
- Added rollback, archive, and export API operations with generated OpenAPI
  models/routes and handler/service tests. Rollback uses an expected-current
  package guard and only restores published/superseded production-safe packages.
- Updated profile CMS docs, architecture docs, and workstream memory with the
  decentralized publish/signing/storage assumptions and remaining remote-byte
  verification caveat.
- Focused validation passed for the current branch:
  `node node_modules/jest/bin/jest.js src/profile-cms/profile-cms-signing.test.ts src/profile-cms/profile-cms-storage.test.ts src/profile-cms/protocol/v1/profile-cms-protocol-v1.test.ts src/api-serverless/src/profile-cms/profile-cms-api-service.test.ts src/api-serverless/src/profile-cms/profile-cms-handlers.test.ts --runInBand --config %TEMP%/jest-profile-cms.config.cjs`
- Targeted ESLint passed on touched CMS signing/storage/pointer/service/handler
  source and tests. Root/API `tsc --noEmit` were attempted but blocked by the
  borrowed local dependency tree and base CMS protocol typing issues before
  providing a clean branch-specific signal.
- Addressed PR #1647 6529bot review feedback locally:
  - added a 15-minute server-side publish deadline cap and documented the
    epoch-millisecond unit in OpenAPI.
  - added `profile_cms_publish_signatures` to consume verified typed-data
    hashes before the pointer transaction.
  - required Safe/EIP-1271 signers to have contract bytecode on the same RPC
    chain selected by `chain_id`.
  - added deterministic `event_sequence` ordering to pointer events.
  - tightened canonical Arweave publish receipts to native `ar://` URIs.
  - added focused tests for verifying-contract domain parity, consumed
    signatures, deadline cap, signer wallet rejection, rollback production
    validity, rollback transaction order, and export omission of raw signature
    and typed data.
  - resolved the Sonar `typescript:S4325` redundant assertion in pointer event
    hydration.

- Created backend profile CMS package persistence:
  `profile_cms_packages` TypeORM entity, table constant, explicit SQL migration,
  repository, publication states, primary package flag, validation result
  fields, and storage receipt indexes for IPFS, Arweave, S3, and fixture
  receipts.
- Ported CMS V1 protocol validation/canonicalization/hash logic from the
  frontend protocol contract into `src/profile-cms/protocol/v1`.
- Added OpenAPI-backed profile CMS endpoints:
  - `GET /profile-cms/{handle}/primary`
  - `POST /profile-cms/packages`
  - `POST /profile-cms/packages/validate`
  - `POST /profile-cms/packages/{id}/publish`
  - `GET /profile-cms/profiles/{profile_id}/packages`
  - `GET /profile-cms/packages/{id}`
  - `GET /profile-cms/profiles/{profile_id}/packages/{package_id}/versions/{version}`
  - `GET /profile-cms/packages/by-hash/{package_hash}`
- Added `PUBLISH_CMS` proxy action and wired it through generated OpenAPI
  models plus proxy create/map logic.
- Publish now requires draft state, enforces expected payload/package hashes
  when provided, runs CMS V1 production validation, rejects fixture
  signatures/storage, and supersedes the previous primary package in a
  transaction.
- Public reads only serve published production-valid rows. Primary returns 404
  on absence, fixture-backed rows, or hash-invalid rows.
- Added focused tests for protocol parity vectors, service happy/permission
  failure/invalid package/hash mismatch/primary lookup/public by-hash behavior,
  and handler envelope paths.
- Focused validation passed:
  `node node_modules/jest/bin/jest.js src/profile-cms/protocol/v1/profile-cms-protocol-v1.test.ts src/api-serverless/src/profile-cms/profile-cms-api-service.test.ts src/api-serverless/src/profile-cms/profile-cms-handlers.test.ts --runInBand --config %TEMP%/jest-profile-cms.config.cjs`
- Final PR-readiness checks passed:
  - targeted ESLint on CMS protocol/service/handler/entity/test files
  - focused Jest CMS set: 3 suites, 23 tests
  - `codex-diff-check`
- PR #1645 opened. Snyk passed, CodeRabbit was rate-limited, and Sonar
  quality gate passed with 18 maintainability findings. Addressed the
  actionable Sonar findings locally with no CMS protocol schema changes.
- Addressed 6529bot backend-service review feedback:
  - primary lookup now resolves the live handle identity and queries by
    profile id, rejecting stale handle rows.
  - publish stores and reads a `production_valid` flag instead of full public
    re-validation on every anonymous read.
  - package version has a unique `(profile_id, package_id, version)` index.
  - publish locks profile package rows and the draft row before superseding the
    previous primary.
  - public by-hash lookup is scoped to published production-valid rows.
  - draft save validates package `primary_wallet` and `eip712` signer ownership
    against the resolved profile wallets.
  - migration SQL debug logging was removed.
- Regenerated API models/routes using the primary checkout OpenAPI generator
  dependency junction so the generated CMS model files match CI output.
- Addressed the URI safety helper bot nit by iterating over characters instead
  of mixing string indexes with `codePointAt`; focused ESLint, focused CMS Jest
  set (3 suites, 23 tests), and `codex-diff-check -- . ':(exclude)src/api-serverless/src/generated'`
  passed afterward.
- Extended the public primary lookup index to `(profile_id, is_primary,
  production_valid)` in the entity and explicit migration to match the hot-path
  query shape.
