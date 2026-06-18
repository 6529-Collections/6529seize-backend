# Active Context

Branch: `codex/cms-wallet-nft-snapshot`

Base: `codex/profile-cms-decentralized-publish`

Current contract:

- New generated API endpoint:
  `POST /api/profile-cms/wallet-gallery/snapshot`.
- Feature flag: `FEATURE_PROFILE_CMS_WALLET_GALLERY`.
- Request accepts `wallets`, `exclude_contracts`, `exclude_assets`,
  `include_spam`, and `max_assets`.
- Wallet inputs normalize Ethereum addresses with `ethers.getAddress` and
  resolve `.eth` names from the existing `ens` table only.
- Holdings source is `nft_owners` joined to `nfts`, `nfts_meme_lab`, and
  `nextgen_tokens`.
- The endpoint reports request-side exclusions in `excluded_assets` and keeps
  spam flags reserved as `false`/`0` until an indexed spam source exists.

Non-goals:

- Do not reindex wallets live.
- Do not add DB schema or migrations.
- Do not alter profile CMS package hashes, signatures, or publish semantics.
