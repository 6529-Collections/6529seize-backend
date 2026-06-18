# Profile CMS Agent Affordance API Run Log

## Scope

Phase 8 backend lane for BYO AI-agent affordances. The backend must expose CMS
draft/package data and validation contracts without making model calls or
applying agent-proposed changes.

## Branch

- Base: `codex/profile-cms-decentralized-publish`
- Work branch: `codex/cms-agent-affordance-api`

## API Contract

- `GET /profile-cms/agent/schema-bundle`
  - Public.
  - Returns schema ids, source-packet categories, patch operation names,
    endpoint templates, and prompt-injection safety metadata.
- `GET /profile-cms/packages/{id}/agent/source-packet`
  - Optional auth.
  - Public only for published production-safe packages.
  - Private draft/package rows require owner or delegated `PUBLISH_CMS`
    authority.
  - Separates `facts`, `author_copy`, `derived_metadata`, and
    `validation_diagnostics`.
- `POST /profile-cms/packages/{id}/agent/patch/validate`
  - Requires owner or delegated `PUBLISH_CMS` authority.
  - Draft-only preflight.
  - Accepts `6529.cms.agent_patch.v1`.
  - Returns `6529.cms.agent_patch_validation_result.v1`.
  - Never applies writes; `applied` is always `false`.

## Safety Notes

- Source packets are data, not instructions.
- `author_copy`, package source packets, wallet/collection/NFT sourced data, and
  validation issue messages/suggestions are explicitly marked as untrusted.
- Patch validation dry-runs in memory only. It does not bypass draft save,
  package validation, storage receipt verification, EIP-712 signature
  verification, consumed-signature replay protection, or publish authority.
- No model calls, inference calls, or paid AI integrations were added.

## Validation

- `npx jest src/api-serverless/src/profile-cms/profile-cms-api-service.test.ts src/api-serverless/src/profile-cms/profile-cms-handlers.test.ts --runInBand`
  - Passed: 41 tests.

## FE Integration Notes

- Use generated OpenAPI models:
  - `ApiProfileCmsAgentSchemaBundle`
  - `ApiProfileCmsAgentSourcePacket`
  - `ApiValidateProfileCmsAgentPatchRequest`
  - `ApiProfileCmsAgentPatchValidationResult`
- Agent adapters should treat `safety.untrusted_fields` as prompt-injection
  boundaries and quote those values as data only.
- For content-changing patches, request patch validation with
  `enforce_hashes=false` while drafting. The normal save/publish flow still
  enforces package hashes and signatures before publication.
- Use `candidate_validation` to show CMS protocol issues to users or external
  agents. Top-level `issues` includes patch preflight errors and candidate CMS
  validation errors for a single list view.
