# Active Context

## Current Decision Points

- Canonical public lookup path is `GET /api/profile-cms/:handle/primary`.
- Public primary lookup returns 404 when there is no primary published
  production-valid package.
- The response envelope is intentionally narrow:
  `{ package, package_id, version, package_hash, payload_hash, updated_at, published_at? }`.
- `PUBLISH_CMS` is the delegated proxy action for profile CMS package
  create/publish rights.
- CMS V1 schema/hash/canonicalization are protocol-owned. Backend has a local
  parity port and tests, but should not add fields casually.

## Local Validation Notes

- Broad dependency install was stopped by coordination. Focused work used the
  available root dependencies and a narrow `ethers@6.16.0` reinstall to restore
  missing local type files from the interrupted install.
- Focused tests run with a lightweight Jest config that skips the repository
  global MySQL testcontainer setup because these are unit/protocol tests.
- Final focused checks passed: targeted ESLint, focused CMS Jest set
  (3 suites, 23 tests), and `codex-diff-check -- . ':(exclude)src/api-serverless/src/generated'`.
- PR #1645 is in bot/check iteration. Latest local follow-up addresses a URI
  safety helper review nit without changing CMS V1 schema or hashes.
