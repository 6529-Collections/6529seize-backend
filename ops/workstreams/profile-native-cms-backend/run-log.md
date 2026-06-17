# Run Log

## 2026-06-17

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
