# Profile CMS Gallery Generator Workstream

## Charter

Own the backend library that turns a normalized wallet/NFT snapshot into a CMS
V1 package for profile-native galleries.

## Owned Paths

- `src/profile-cms/profile-cms-gallery-package-generator.ts`
- `src/profile-cms/profile-cms-gallery-package-generator.test.ts`
- `docs/profile-cms-gallery-generator.md`
- `docs/profile-cms-packages.md`
- `docs/_manager/profile-cms-gallery-generator/*`

## Constraints

- Preserve the existing CMS V1 package schema and validation contract.
- Keep generation pure and deterministic so it can run offline/decentralized.
- Keep fixture signature/storage clearly marked as preview-only.
- Do not add API routes or persistence without coordinating with the profile CMS stack owner.

## Validation Standard

- Focused Jest coverage for deterministic output, route collisions, grouping,
  NFT detail pages, media references, and CMS validation pass/fail.
- `npm run lint` after code/doc changes.
- `codex-diff-check` before PR publication.

## Escalation

Escalate if the snapshot lane changes required fields, if FE needs a route before
the backend API boundary is approved, or if CMS V1 schema changes are requested.
