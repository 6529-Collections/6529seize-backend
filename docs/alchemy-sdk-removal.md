# Removing the `alchemy-sdk` dependency

Branch: `codex/remove-alchemy-sdk-dependency-completely` (PR #1519)
Date: 2026-04-21

## Why

The `alchemy-sdk` package was pinning an old major of `ethers`, pulling in a
transitive `@ethersproject/hash` (ethers v5), and gave us a large API surface
we only use a sliver of. This branch replaces it with a small in-tree wrapper
that keeps the `Alchemy`, `Network`, `AssetTransfersCategory`, `SortingOrder`,
`Nft`, `NftContract`, `Log`, `TransactionResponse` identifiers that the rest
of the codebase already imports, but talks to Alchemy directly over HTTP
(JSON-RPC + NFT REST v3) and delegates Ethereum-standard calls to
ethers v6's `JsonRpcProvider`.

Runtime behaviour is intended to be identical, so this is a refactor rather
than a feature change. No public API of the backend moves.

## What the new wrapper gives you

All under `src/alchemy-sdk.ts`, imported via `@/alchemy-sdk`:

- `Alchemy` — constructed with `{ network, apiKey, maxRetries? }`. Owns a
  dedicated axios instance (with `axios-retry` wired for 429 / 5xx / network
  errors). `maxRetries` defaults to 3 and is honoured per-instance
  (nextgen passes `10`, preserving prior behaviour).
- `alchemy.core`
  - `getBlockNumber()`, `getBlock(tag)`, `getTransaction(hash)`,
    `getTransactionReceipt(hash)`, `getLogs(filter)`, `resolveName(name)` —
    forwarded to a cached `ethers.JsonRpcProvider`.
  - `getBlock` now returns a stable POJO (`Block`) rather than an ethers
    class instance. Same fields, no methods.
  - `getLogs` returns plain `Log` objects (fields only, no
    `toJSON`/`getBlock`/`removedEvent` methods).
  - `getAssetTransfers(params)` — posts `alchemy_getAssetTransfers` as
    JSON-RPC and surfaces in-band JSON-RPC errors as `Error` with
    `{ status, code }`.
- `alchemy.nft`
  - `getNftMetadata(contract, tokenId, options?)` — REST `GET /getNFTMetadata`.
  - `getContractMetadata(contract)` — REST `GET /getContractMetadata`.
  - `searchContractMetadata(query)` — REST `GET /searchContractMetadata`.
  - `getNftsForOwner(owner, options?)` — REST `GET /getNFTsForOwner`, array
    params serialised as repeated `key=a&key=b` (what Alchemy's NFT REST v3
    expects).
  - `getNftMetadataBatch(tokens)` — REST `POST /getNFTMetadataBatch`.
- `Network` enum: `ETH_MAINNET`, `ETH_SEPOLIA`, `ETH_GOERLI` — values match
  Alchemy's subdomain segment (`eth-mainnet`, etc.).
- `fromHex(hex)` — small helper kept for callers that need it.

Retries are shared across JSON-RPC and NFT REST paths (single axios instance
per Alchemy instance). Tests cover the retry wiring, JSON-RPC happy/error
paths, and each NFT REST shape.

## Behavioural notes and gotchas

- `Block`/`Log` are now plain data types. Any caller that relied on ethers'
  class methods (`block.toJSON()`, `log.removedEvent()`, etc.) would have to
  change — a `grep` across the repo shows none do.
- `core.getBlock` throws when ethers returns `null` (previously alchemy-sdk
  returned `null`). All current callers already checked for the block and
  threw; behaviour is preserved.
- `getAssetTransfers` error format changed slightly: in-band JSON-RPC errors
  become `Error & { status, code }`, HTTP-level errors become
  `Error & { status, code? }`. Consumers that inspected the previous
  alchemy-sdk `AlchemyError` shape should be fine because the codebase does
  not — it only reads `.message`.
- `resolveName`, `getTransaction`, `getTransactionReceipt` return exactly what
  ethers v6 returns — same as before, since alchemy-sdk v3 already proxied to
  ethers.
- `hashMessage` now comes from `ethers` (v6) directly in
  `api-serverless/src/nextgen/validation.ts` and
  `api-serverless/src/rememes/rememes_validation.ts`. The old
  `@ethersproject/hash` transitive dep is gone.

## File-level change list

### New

- `src/alchemy-sdk.ts` — the wrapper.
- `src/alchemy-sdk.test.ts` — retry config + core + NFT REST coverage.

### Package changes

- `package.json` — removed `alchemy-sdk` dependency. `axios` and
  `axios-retry` were already present.
- `src/nftOwnersLoop/package.json` — removed `alchemy-sdk` dep.
- `src/ownersBalancesLoop/package.json` — removed `alchemy-sdk` dep.
- `src/transactionsProcessingLoop/package.json` — removed `alchemy-sdk` dep.
- `package-lock.json` — regenerated.
- `pnpm-lock.yaml` — deleted (the repo is npm, the file should not exist).

### Import-only updates (`from 'alchemy-sdk'` → `from '@/alchemy-sdk'`)

- `src/alchemy.ts`
- `src/api-serverless/src/alchemy-proxy/alchemy-proxy.routes.ts`
- `src/api-serverless/src/community-members/user-groups.service.ts`
- `src/api-serverless/src/identities/identity.fetcher.ts`
- `src/api-serverless/src/nextgen/validation.ts`
- `src/api-serverless/src/rememes/rememes_validation.ts`
- `src/art-curation/art-curation-token-watch.onchain.ts`
- `src/constants/index.ts`
- `src/db-api.ts`
- `src/delegations.ts`
- `src/groups/user-group-predicates.ts`
- `src/groups/user-group-predicates.test.ts`
- `src/nextgen/nextgen.ts`
- `src/nextgen/nextgen_constants.ts`
- `src/nextgen/nextgen_core_events.ts`
- `src/nextgen/nextgen_core_transactions.ts`
- `src/nextgen/nextgen_minter.ts`
- `src/nextgen/nextgen_pending_thumbnails.ts`
- `src/nft_history.ts`
- `src/rememesLoop/index.ts`
- `src/rpc-provider.ts`
- `src/subscriptionsTopUpLoop/alchemy.subscriptions.ts`
- `src/subscriptionsTopUpLoop/subscription_topups.ts`
- `src/tdhLoop/tdh.ts`
- `src/transaction_values.ts`
- `src/transactions/transactions-discovery.service.ts`

### Small code edits

- `src/alchemy.ts` — collapsed `if (!alchemy || alchemy.config.network != network)` into `if (alchemy?.config.network !== network)` (SonarQube S6582; also upgrades `!=` to `!==`).
- `src/api-serverless/src/nextgen/validation.ts` — `hashMessage` now imported from `ethers` directly (alongside existing `ethers` import) instead of `@ethersproject/hash`.
- `src/api-serverless/src/rememes/rememes_validation.ts` — same `hashMessage` source change.

## Deployment plan (`deploy.yml` services)

All lambdas that consume Alchemy (NFT metadata, asset transfers, JSON-RPC via
`getAlchemyInstance`, or NFT REST) ship a new wrapper in their bundle and
should be redeployed. The order below is the safest one — API last so any
loop-side regression is caught before the user-facing surface changes.

### Group 1 — loops that hit Alchemy directly (redeploy first, any order within the group)

- `artCurationNftWatchLoop` (imports the changed `art-curation-token-watch.onchain.ts`)
- `delegationsLoop`
- `mintAnnouncementsLoop`
- `nextgenContractLoop`
- `nextgenMetadataLoop`
- `nftHistoryLoop`
- `nftOwnersLoop` (also drops `alchemy-sdk` from its own `package.json`)
- `nftsLoop`
- `ownersBalancesLoop` (also drops `alchemy-sdk` from its own `package.json`)
- `rememesLoop`
- `subscriptionsTopUpLoop`
- `tdhHistoryLoop`
- `tdhLoop`
- `transactionsLoop`
- `transactionsProcessingLoop` (also drops `alchemy-sdk` from its own `package.json`)
- `populateHistoricConsolidatedTdh`

### Group 2 — ENS/RPC-adjacent loops (safe to redeploy; no expected behaviour change but bundles differ)

- `discoverEnsLoop`
- `refreshEnsLoop`
- `externalCollectionLiveTailingLoop`
- `externalCollectionSnapshottingLoop`
- `waveDecisionExecutionLoop`
- `waveLeaderboardSnapshotterLoop`
- `xTdhLoop` / `xTdhGrantsReviewerLoop`
- `rateEventProcessingLoop`
- `overRatesRevocationLoop`
- `marketStatsLoop`
- `royaltiesLoop`
- `aggregatedActivityLoop`

If you want to minimise redeploys, Group 2 can be skipped — these either only
use ethers directly (unchanged) or import non-Alchemy helpers from modules
that only had import-path tweaks. Group 1 is the must-ship list.

### Group 3 — no need to redeploy

- `dbMigrationsLoop`, `dbDumpsDaily`, `s3Uploader`, `mediaResizerLoop`,
  `dropVideoConversionInvokerLoop`, `ethPriceLoop`, `cloudwatchAlarmsToDiscordLoop`,
  `pushNotificationsHandler`, `claimsBuilder`, `claimsMediaArweaveUploader`,
  `customReplayLoop`, `nextgenMediaImageResolutions`,
  `nextgenMediaProxyInterceptor`, `nextgenMediaUploader`, `nftLinkRefresherLoop`,
  `nftLinkMediaPreviewLoop`, `subscriptionsDaily`, `teamLoop`

These don't consume Alchemy and have no code path that imports the changed
files.

### Group 4 — API (redeploy last)

- `api`

The API surface touches all four alchemy code paths: alchemy-proxy routes,
identity fetcher, user-groups service, rememes validation, and nextgen
validation.

## Verification checklist for reviewers

1. `npm run build` at root and under `src/api-serverless` completes cleanly.
2. `npm test` — `src/alchemy-sdk.test.ts` covers the wrapper.
3. Spot-check `rememesLoop` in staging: `getContractMetadata` and
   `getNftMetadata` should return the same JSON shape as before.
4. Spot-check `nextgenContractLoop` in staging: `getAssetTransfers` pagination
   and log decoding unchanged.
5. Spot-check the API's `/identities` and `/alchemy-proxy` routes.
