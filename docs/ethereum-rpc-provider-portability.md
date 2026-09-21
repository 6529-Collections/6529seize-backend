# Ethereum RPC Provider Portability

Status: Foundation [BE #1985](https://github.com/6529-Collections/6529seize-backend/pull/1985)
merged on 2026-09-21. Remaining backend implementation is included in
[BE #1979](https://github.com/6529-Collections/6529seize-backend/pull/1979).
No backend deployment is established by this record.

This is the cross-repository decision and backend execution record. Frontend
implementation merged in [FE #3911](https://github.com/6529-Collections/6529seize-frontend/pull/3911)
on 2026-09-15. Its [execution record](https://github.com/6529-Collections/6529seize-frontend/blob/7c48047f3281c010825ed7d8c8ca9213475a58da/ops/workstreams/ethereum-rpc-provider-portability/README.md)
owns frontend rollout details; merge does not prove production deployment.

## Decision and delivery

Make ordinary application Ethereum mainnet reads provider-neutral using one
server-only `ETHEREUM_RPC_URL`. Initially keep it pointed at Alchemy. Later
replace that value and restart/redeploy affected services without application
code changes, after qualifying the replacement RPC.

The original delivery plan was a docs-only parent plus three implementation
PRs. At the user's request, the two remaining implementation parts are now
combined in existing #1979 after the merged foundation #1985. #1979 is no longer
a docs-only PR.

| Work | Delivery |
| --- | --- |
| Configuration, URL validation, lazy shared provider and environment-loader coverage | Merged BE #1985; originally unused, no runtime switch |
| Ordinary callers, mixed indexing split, trace isolation and obsolete-helper removal | BE #1979, this implementation |
| Frontend unused Alchemy facade removal | Merged [FE #3915](https://github.com/6529-Collections/6529seize-frontend/pull/3915) |
| Frontend server-only ordinary RPC and address-type resolution | Merged FE #3911 |

## Implemented backend boundary

- `getEthereumRpcProvider(chainId)` is the shared ethers provider. Existing
  `getRpcProvider(network)` delegates to it. Providers are lazy, cached by chain
  and URL, and recreated when destroyed. Unsupported chains and absent/invalid
  URLs fail explicitly, without deriving an Alchemy URL.
- `EthereumRpcClient` contains the former ordinary compatibility methods:
  blocks, logs, transactions, receipts and forward ENS. It retains transient
  retries, missing-block errors, nullable transaction/receipt results, bigint
  values, numeric timestamps and the existing `logIndex` result shape.
- Provider-neutral network identifiers and response types now live under
  `src/ethereum-rpc/`. Existing identifier strings remain unchanged for
  persisted/configuration compatibility; they do not select a vendor.
- Contract reads, code, balances, wallet/CMS signatures, NextGen validation,
  marketplace reads and simulations use the canonical URL. CMS forward ENS
  retains an isolated 1.5-second transport/4-second overall deadline,
  one transport attempt, disabled CCIP reads, one-minute cache and owned
  destruction. Marketplace batch preflight keeps its bounded raw HTTP transport
  and checks `eth_chainId` before sending stored transaction data.
- Reverse ENS first uses ethers lookup, then the Universal Resolver on the
  **same** configured endpoint. The previous hard-coded 6529 ordinary fallback
  is removed; lookup misses/errors still yield no name. Configuration failures
  remain explicit.
- NFT history, transactions, NextGen and subscription discovery keep indexed
  calls on Alchemy while ordinary reads use the shared boundary. Pagination,
  finality gaps, checkpoints, receipt reconciliation and value conversions are
  preserved.
- `src/alchemy-sdk.ts` is still an active **local** indexed compatibility
  module, not the published Alchemy SDK. It now exposes only indexed transfers
  and NFT REST capabilities. Its standard RPC methods and the Alchemy-derived
  `getRpcUrl*` helpers are removed.

## Explicit retained dependencies and exceptions

This is ordinary-RPC portability, not complete removal of Alchemy.

| Capability | Policy after #1979 |
| --- | --- |
| Alchemy NFT REST and `alchemy_getAssetTransfers` | Remain Alchemy-specific and require `ALCHEMY_API_KEY`; retry and pagination contracts unchanged |
| Non-standard `trace_block` | Isolated in `trace-provider.ts`. Alchemy by default; existing mainnet 6529-first consumers retain Alchemy fallback. Ordinary transactions/receipts always use the canonical RPC |
| Trace failure | Preserve the existing empty-internal-transfers failure behavior and per-invocation cache eviction; can leave trace-derived value attribution incomplete. No ordinary-provider fallback is attempted |
| `NFT_INDEXER_RPC` | Retained as the independent bulk external-indexing and NFT-link capacity boundary, including its specialized resolution deadlines/transport. Changing `ETHEREUM_RPC_URL` does not change it |
| Legacy AWS Managed Blockchain `/rpc` | Public proxy contract unchanged. Consumer investigation and any removal/repointing require separate scoped work |
| Browser wallets and transaction submission | Outside this server-read migration; wallet-selected transports remain unchanged |

The retained bulk indexer already accepts a provider-neutral URL. Consolidating
its traffic into the ordinary provider would be a separate capacity/operational
decision, not necessary to remove Alchemy-derived ordinary URLs.

Tracing is not guaranteed by standard Ethereum JSON-RPC. Do not repoint traces
implicitly when replacing the ordinary URL. Existing Alchemy trace and indexed
credentials must remain available; no new trace configuration is introduced.

## Configuration

| Chain | Chain ID | Server-only setting |
| --- | --- | --- |
| Ethereum mainnet | 1 | `ETHEREUM_RPC_URL` |
| Sepolia | 11155111 | `ETHEREUM_SEPOLIA_RPC_URL` |
| Goerli compatibility | 5 | `ETHEREUM_GOERLI_RPC_URL` |

Use complete HTTP(S) endpoint URLs, initially the appropriate Alchemy endpoint.
Treat the entire value as a secret. Do not put URL values in reports or logs;
validation errors contain setting names only. Ethers checks the expected chain,
without `staticNetwork`. Construction alone does not qualify the endpoint.

Mainnet configuration is now **required when migrated callers run**. Merely
having `ALCHEMY_API_KEY` no longer enables those reads or marketplace capability
gates. Keep that key for API NFT proxy/Rememes validation, NFT history,
transaction/NextGen/subscription indexing, `rememesLoop` and Alchemy tracing.
Do not remove a shared key from staging or production.

Testnet URLs are needed only for enabled corresponding paths: NextGen,
structured-wallet/CMS signatures, subscriptions (Sepolia) and supported
delegation paths. Never reuse the mainnet URL for testnet. Goerli exists for
code compatibility, not as a claim that a live RPC is available. Hoodi and
unknown chains are rejected by the RPC factory.

### Existing runtime secret delivery

- Lambda loops load all keys from regional Secrets Manager `prod/lambdas`
  through `doInDbContext` / `prepEnvironment`.
- Staging uses `eu-west-1`; production uses `us-east-1`. Despite the shared
  secret ID, these are independent regional records.
- API uses that loader when `API_LOAD_SECRETS=true`. Otherwise supply the URL
  through the API's established runtime environment. Verify the deployed mode.
- Local runs use repository-root `.env.<NODE_ENV>`; the API-folder sample is
  reference only. Existing process values override dotenv; loaded shared-secret
  values override matching process values.
- No additional GitHub Actions secret, per-service Serverless field or
  shared-loader change is required by this implementation.

The user reported adding the mainnet URL in staging and production before this
implementation. Deployed values and endpoint behavior have **not** been verified
by this task. Do not infer runtime readiness from that report alone.

## Affected services and deployment order

The source-derived inventory includes indirect ordinary-provider consumers.
Use the following rollout order after configuration verification; there are no
new schema or cross-service contract dependencies in this change. Existing
deployment prerequisites still apply, but do not redeploy unrelated services
merely to align SHAs.

| Order | Service | Affected behavior |
| --- | --- | --- |
| 1 | `api` | ENS/identity/drop resolution, contract-wallet and CMS signatures, NextGen validation, marketplace/collect reads and capability gates |
| 2 | `discoverEnsLoop` | New-wallet reverse ENS |
| 3 | `refreshEnsLoop` | Reverse ENS refresh |
| 4 | `delegationsLoop` | Blocks, logs, transactions and ENS |
| 5 | `nftsLoop` | Edition-size contract reads |
| 6 | `nftHistoryLoop` | Blocks, transactions and receipts alongside indexed transfers |
| 7 | `transactionsLoop` | Transactions, receipts, ENS and isolated traces alongside indexed transfers |
| 8 | `nextgenContractLoop` | Blocks, logs, transactions, receipts, ENS, contract reads and isolated traces alongside indexed transfers |
| 9 | `tdhLoop` | Block/timestamp lookup |
| 10 | `subscriptionsTopUpLoop` | Head and checkpoint timestamps alongside indexed top-ups |
| 11 | `mintAnnouncementsLoop` | Manifold contract reads |
| 12 | `artCurationNftWatchLoop` | Contract reads |
| 13 | `populateHistoricConsolidatedTdh` | Historical block timestamps; update before its next authorized manual use, **do not invoke as a smoke test** |

External collection indexing, NFT-link resolver/refresher and the legacy proxy
retain their own endpoints. `rememesLoop` remains indexed-only. These do not
need deployment solely for an import-only move of neutral network types.
Frontend rollout remains independent; no frontend change or deployment is
required for this backend PR.

## Rollout, verification and rollback

1. Verify mainnet URL presence and API loading mode for each target environment,
   without logging secrets. Provision testnet URLs before exercising those paths.
   Verify retained `ALCHEMY_API_KEY` availability for `transactionsLoop` and
   `nextgenContractLoop`: missing trace credentials preserve ordinary reads but
   degrade trace-derived attribution to empty internal transfers.
2. Merge and deploy only under separate explicit authorization. Start with
   staging and the ordered affected services above; no deploy is part of this
   implementation work itself.
3. Verify API ENS/identity resolution, an EIP-1271 contract-wallet check,
   NextGen validation and marketplace reads/preflight. Test ordinary block,
   receipt, log and contract reads with the configured endpoint. Missing or
   wrong-chain configuration must not silently select Alchemy or mainnet.
   During `discoverEnsLoop` and `refreshEnsLoop` rollout, compare reverse ENS
   results for a fixed sample of previously resolving wallets before and after
   deployment. Watch for increased null results or lost names even if the loops
   report no errors: removing the hidden 6529 endpoint fallback can silently
   reduce coverage. Investigate the configured provider before promoting if
   that sample regresses.
4. Check worker ingestion progress and errors, NFT history/transaction receipt
   consistency, NextGen logs and subscription checkpoints. Confirm colocated
   Alchemy indexed calls still work and trace-derived attribution remains
   consistent. Do not run a historical backfill just for validation.
5. Promote only after the authorized staging assessment. Restart/redeploy
   affected processes because warm secrets and provider caches persist.
6. Later, qualify a replacement such as `rpc1.6529.io` for chain ID, historical
   state/archive depth, log range limits, rate limits, latency, batch behavior,
   standard methods and production load. Change only `ETHEREUM_RPC_URL` for
   the ordinary mainnet boundary; separately manage the exceptions above.
7. Roll back a provider switch by restoring the prior URL and restarting affected
   services. To roll back the code, redeploy the previous service artifacts with
   their old credentials intact. **Do not remove the new URL while migrated
   code is running.**

## Acceptance evidence and remaining operational work

Implementation coverage exercises provider URL/chain selection, missing/invalid
configuration, network mismatch, retry limits, nulls/bigints/log shape,
ENS fallback, bounded CMS resolution, contract signatures, marketplace
preflight and mixed indexing. Subscription tests cover pagination, deduplication,
checkpoint timestamps and failure without checkpoint advancement. Transaction
tests cover ordinary/trace isolation and trace fallback.

Live endpoint qualification and staging/production service verification remain
operational work; mocked tests do not prove deployment or provider capabilities.
No public API schema, database entity, queue, workflow or dependency changes
are required. `ALCHEMY_API_KEY`, `NFT_INDEXER_RPC` and the legacy proxy remain
explicitly outside the single ordinary-mainnet-URL replacement promise.
