# Meme Claims – Overview

This document describes how meme claims are created and edited, how minting merkles work, who can do what, and which services are involved.

---

## 1. How claims are created and edited

### Creation (automatic)

- A meme claim is created automatically when a **wave decision** is executed and the wave is the main-stage wave (`MAIN_STAGE_WAVE_ID`).
- The **single winner drop** of that decision is used: `MemeClaimsService.createClaimForDrop(winner.drop_id)` is called from `WaveDecisionExecutionService` inside the same transaction as the decision.
- Flow:
  1. Next `meme_id` is `max(meme_id) + 1` from the NFTs data.
  2. Drop media and metadata for the winner drop are loaded.
  3. `buildMemeClaimRowFromDrop` builds a claim row from the drop (title, description, attributes from metadata; primary media → `image` / `animation_url`; mime → initial `image_details` / `animation_details`).
  4. `image_location`, `animation_location`, `metadata_location` are always `null` at creation (reserved for Arweave tx IDs after upload).
  5. `arweave_synced_at` is `null` (not yet synced to Arweave).
  6. Media inspection runs: image URL → real `image_details` (bytes, sha256, width, height, format); animation URL → real `animation_details` (video: bytes, duration, codecs, etc.; HTML stays `{ format: 'HTML' }`).
  7. Row is inserted into `memes_claims`.

### Editing (API, admin only)

- **GET** `GET /memes-minting/claims` (optional `meme_id`) and **GET** `/memes-minting/claims/:drop_id` return one or all claims.
- **PATCH** `PATCH /memes-minting/claims/:drop_id` does a partial update. Request body uses `MemeClaimUpdateRequest` (e.g. `description`, `name`, `image`, `animation_url`, `attributes`, `image_details`, `animation_details`, etc.). Only provided fields are updated.
- **Server-side rules on PATCH:**
  - `arweave_synced_at` is **never** accepted from the client. The server **always** sets `arweave_synced_at = null` when any PATCH is applied (claim is considered “out of sync” with Arweave after an edit).
  - If the client sends a new `image` URL, the server computes new `image_details` from that URL (fetch + sharp) and overwrites `image_details`; if `image` is cleared, `image_details` is set to `null`.
- Location fields (`image_location`, `animation_location`, `metadata_location`) can be sent in PATCH but are normally only set by the Arweave upload flow.

### Arweave upload (API, admin only)

- **POST** `/memes-minting/claims/:drop_id/arweave-upload` uploads the claim to Arweave.
- **Preconditions:** Claim must have an `image` URL (else 400). Claim must not already be synced (`arweave_synced_at == null`), else 409.
- **Behaviour:** Uploads image → Arweave (tx ID → `image_location`). If there is an `animation_url`: if HTML, copies URL into `animation_location`; otherwise uploads animation to Arweave and sets `animation_location`. Builds metadata JSON (with Arweave URLs) and uploads it → `metadata_location`. Then sets `arweave_synced_at = Date.now()`.
- **Sync meaning:** `arweave_synced_at != null` means “this claim’s current content has been uploaded to Arweave.” Any PATCH clears it so the claim must be re-uploaded if needed.

---

## 2. How merkles work

- Minting allowlists use a **Merkle tree**: leaves are (address, index) hashed; tree is built with keccak256 and sorted pairs; root and per-address proofs are stored.
- **Writing data:** When distributions are created/updated with allowlists, the API (distributions service) calls `computeAllowlistMerkle(entries)` to get `merkleRoot` and `proofsByAddress`, then in a transaction: deletes existing merkle for that contract/card/phase, then `insertMintingMerkleRoot` and `insertMintingMerkleProofs`.
- **Reading data (public, no auth):**
  - **GET** `/memes-minting/roots/:contract/:card_id` – returns merkle roots (one per phase) for that contract and card.
  - **GET** `/memes-minting/proofs/:merkle_root` – returns proofs for a root. Optional query `address`: if present, returns proofs for that address only (`MemesMintingProofsResponse`); if omitted, returns proofs for all addresses (`MemesMintingProofsByAddressResponse`). `merkle_root` must be 0x-prefixed 64-char hex.

---

## 3. Auth – who has access to what

| Resource / action | Who can access |
|-------------------|----------------|
| **Claims** – GET list, GET by `drop_id`, PATCH, POST arweave-upload | Authenticated user whose wallet is in **DISTRIBUTION_ADMIN_WALLETS** (distribution admin). Else 403. |
| **Merkle roots** – GET `/memes-minting/roots/:contract/:card_id` | Public (no auth). |
| **Merkle proofs** – GET `/memes-minting/proofs/:merkle_root` | Public (no auth). |
| **Creating a claim** (in backend) | Only the wave decision execution flow when the wave is main-stage; not callable via API. |

All claim and Arweave-upload endpoints use `needsAuthenticatedUser()` and then `isDistributionAdmin(req)` (wallet in `DISTRIBUTION_ADMIN_WALLETS`). Proofs and roots routes do not require auth.

---

## 4. Affected services

| Service / area | Role |
|----------------|------|
| **API (api-serverless)** | Claims CRUD and Arweave upload routes; merkle proofs/roots read routes; distributions service writes merkle roots/proofs. Uses generated models (e.g. `MemeClaim`, `MemeClaimUpdateRequest`, `MemesMintingClaimsResponse`, `MemesMintingProofsResponse`, `MemesMintingRootsResponse`). |
| **Database** | Tables: `memes_claims` (claims), `minting_merkle_roots`, `minting_merkle_proofs`. TypeORM entity `MemeClaimEntity`; schema kept in sync by dbMigrations loop (sync), no separate migration for claim/merkle table creation. |
| **Wave decision execution** | When executing a decision for the main-stage wave, creates one meme claim for the winning drop via `MemeClaimsService.createClaimForDrop`. Runs in backend (Lambda/cron). |
| **Meme claims namespace (backend)** | `meme-claims/meme-claim-from-drop.builder.ts`, `meme-claims/meme-claims.db.ts`, `meme-claims/meme-claims.service.ts`, `meme-claims/media-inspector.ts`. Builder + DB used by both backend (create) and API (read/update via api.memes-minting.db). |
| **Distributions (API)** | When saving distributions with allowlists, computes merkle and calls `insertMintingMerkleRoot` / `insertMintingMerkleProofs` in api.memes-minting.db. |
| **Arweave** | `src/arweave.ts` – `ArweaveFileUploader.uploadFile` used by the Arweave upload route. Requires `ARWEAVE_KEY` in env. |
| **Constants** | `DISTRIBUTION_ADMIN_WALLETS`, `MEMES_CLAIMS_TABLE`, `MINTING_MERKLE_ROOTS_TABLE`, `MINTING_MERKLE_PROOFS_TABLE`. |
