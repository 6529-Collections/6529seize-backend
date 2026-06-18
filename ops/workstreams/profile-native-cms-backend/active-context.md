# Active Context

## Current Decision Points

- Active branch for the next stacked lane is
  `codex/profile-cms-decentralized-publish`, based on
  `codex/profile-cms-backend` / BE PR #1645 head `33c81546`.
- This lane is limited to backend decentralized publish hardening: signing,
  storage receipt validation, pointer events, rollback, export, tests, and docs.
  Do not expand into builder UX, gallery generation, storage upload/pinning, or
  AI-agent affordances without a new coordinator assignment.
- Canonical public lookup path is `GET /api/profile-cms/:handle/primary`.
- Public primary lookup returns 404 when there is no primary published
  production-valid package.
- The response envelope is intentionally narrow:
  `{ package, package_id, version, package_hash, payload_hash, updated_at, published_at? }`.
- `PUBLISH_CMS` is the delegated proxy action for profile CMS package
  create/publish rights.
- CMS V1 schema/hash/canonicalization are protocol-owned. Backend has a local
  parity port and tests, but should not add fields casually.
- Publish EIP-712 typed data uses domain name `6529 Profile CMS`, version `1`,
  the request `chain_id`, and optional `verifying_contract`. The
  `ProfileCmsPublish` message binds action, profile, handle, package id,
  version, draft row id, payload/package hashes, primary path, canonical storage
  provider/URI/content hash, and deadline.
- Production publish requires exactly one canonical decentralized receipt
  (`ipfs` or `arweave`) whose `content_hash` equals the package hash. S3 and
  fixture receipts are not sufficient for publish. Canonical Arweave receipts
  use native `ar://` URIs.
- Publish deadlines are Unix epoch milliseconds and may be at most 15 minutes
  in the future when received by the server.
- Verified publish typed-data hashes are consumed in
  `profile_cms_publish_signatures` inside the publish transaction before
  package pointer mutations.
- Pointer events live in `profile_cms_pointer_events` and cover publish,
  set-primary, supersede, rollback, and archive. `event_sequence` preserves
  logical ordering for same-millisecond event groups.

## Local Validation Notes

- Broad dependency install was stopped by coordination. Focused work used the
  available root dependencies and a narrow `ethers@6.16.0` reinstall to restore
  missing local type files from the interrupted install.
- Focused tests run with a lightweight Jest config that skips the repository
  global MySQL testcontainer setup because these are unit/protocol tests.
- Current local bot-response patch focused checks passed: targeted ESLint,
  focused CMS Jest set (5 suites, 46 tests), `npm run generate:deploy-config`,
  and `codex-diff-check` for non-generated changes.
- Root `tsc --noEmit` currently fails before a useful branch-specific signal
  because the borrowed dependency tree resolves `openai` without declarations.
  API `tsc --noEmit` also reports base protocol typing and dependency lib
  errors in this local dependency shape.
- PR #1645 is in bot/check iteration. Latest local follow-up addresses a URI
  safety helper review nit and primary hot-path index coverage without changing
  CMS V1 schema or hashes.
