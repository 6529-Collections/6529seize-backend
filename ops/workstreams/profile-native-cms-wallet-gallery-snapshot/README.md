# Profile Native CMS Wallet Gallery Snapshot

Mission: provide the backend data spine for profile CMS wallet gallery
generation.

Owned paths:

- `src/profile-cms/wallet-gallery/**`
- `src/api-serverless/src/profile-cms/wallet-gallery*`
- `src/api-serverless/openapi.yaml`
- `src/api-serverless/src/generated/**`
- `docs/profile-cms-packages.md`
- `docs/architecture.md`

Contract:

- `POST /api/profile-cms/wallet-gallery/snapshot`
- Auth required.
- Gated by `FEATURE_PROFILE_CMS_WALLET_GALLERY=true`.
- Reads existing indexed ownership and metadata only; no live wallet indexing,
  no chain fetch, no package hash/signing change.
- Output is deterministic for the same indexed rows, request inputs, and clock:
  assets are sorted by collection order, contract, token id, and owner wallet.

Escalate before changing CMS V1 package schema, hash/canonicalization rules,
publish signing semantics, or decentralized storage receipt rules.
