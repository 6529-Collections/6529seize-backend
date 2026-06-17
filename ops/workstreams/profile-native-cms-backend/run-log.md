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
  - focused Jest CMS set: 3 suites, 17 tests
  - `codex-diff-check`
