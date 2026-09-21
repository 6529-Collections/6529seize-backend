# Ethereum RPC foundation

First implementation slice of the
[backend portability plan, PR #1979](https://github.com/6529-Collections/6529seize-backend/pull/1979).
This slice adds configuration and an unused shared provider. It does not migrate
callers, provision secrets, deploy services, or complete backend portability.

## Configuration contract

| Chain | Chain ID | Server-only configuration |
| --- | --- | --- |
| Ethereum mainnet | 1 | `ETHEREUM_RPC_URL` |
| Sepolia | 11155111 | `ETHEREUM_SEPOLIA_RPC_URL` |
| Goerli compatibility | 5 | `ETHEREUM_GOERLI_RPC_URL` |

`src/ethereum-rpc/ethereum-rpc.config.ts` validates configuration on demand.
Only complete HTTP(S) URLs are accepted; whitespace, backslashes and fragments
are rejected. Credential-bearing paths, queries and HTTPS basic authentication
are allowed. Validation errors name only the setting, never its value or the
underlying URL-parser error. Treat the entire URL as a secret.

`getEthereumRpcProvider(chainId = 1)` in
`src/ethereum-rpc/ethereum-rpc-provider.ts` lazily caches ethers providers by
chain and URL. It reads configuration at call time, after environment loading.
Missing URLs and unsupported chains fail closed; it never derives an Alchemy
endpoint or falls back to another chain. The expected chain is passed to ethers
without `staticNetwork`, retaining network-mismatch checks on use. Construction
alone does not contact or qualify the endpoint. Ethers' default transport
settings remain unchanged; the compatibility client's additional retry wrapper
is not implicitly reproduced here and must be preserved where needed during
caller migration.

Destroyed cache entries are replaced on the next request. Live providers for
previous URLs remain cached until process restart so URL changes do not destroy
transports that existing callers may still be using. Continuous in-process URL
rotation is not the supported rollout path; restart/redeploy when switching
providers. Revisit cache eviction with caller lifecycle ownership during migration.

The existing `src/rpc-provider.ts`, `src/alchemy.ts`, `src/alchemy-sdk.ts`, ENS
fallback, tracing and callers are unchanged. Merely adding or omitting the new
settings cannot repoint or break existing RPC consumers in this slice.

## Existing deployment wiring, not new Actions secrets

Backend runtime settings already flow through `src/env.ts`:

- Loop handlers enter `doInDbContext`, which calls `prepEnvironment`. In Lambda,
  it reads **all keys** from Secrets Manager `prod/lambdas` in the runtime AWS
  region into `process.env` before running the job.
- The API calls `loadSecrets` when `API_LOAD_SECRETS=true`. Verify that flag on
  the deployed API before relying on the shared-secret path. Do not silently
  change its loading mode in this foundation PR. An API not using that path
  must receive the settings through its established runtime environment.
- Staging deployments target `eu-west-1`; production targets `us-east-1`.
  Despite its name, `prod/lambdas` is the secret ID used by the loader in both
  regions. These are distinct regional records, not a shared staging/prod URL.
- Local processes load the repository-root `.env.<NODE_ENV>` through
  `loadLocalConfig`; the API-folder `.env.sample` is reference material, not
  the loaded file. Existing process environment values take precedence over
  dotenv; the shared-secret loader overwrites matching process values.

No new GitHub Actions secrets, Serverless URL fields, or shared-loader changes
are necessary: the current loader already delivers the new keys to every
participating service. Mocked regional-secret and local-loader tests exercise
that path through construction of the real ethers provider without network
requests. This is code-level wiring evidence, not proof of deployed values.

Before caller migration, provision `ETHEREUM_RPC_URL` with an Alchemy mainnet
endpoint in each applicable runtime configuration source, and verify it was
loaded without printing its value. Keep `ALCHEMY_API_KEY` unchanged. Do not
put a conflicting URL in both Lambda environment variables and the shared
secret; the secret wins. Restart/redeploy affected processes when validating
new settings, since warm workers can retain loaded secrets and provider caches.

## Source-derived consumer inventory

The following confirmed ordinary-read paths need mainnet configuration before
migration. All listed loops already load the shared secret through
`doInDbContext`; the API uses the conditional path above.

| Deployable | Confirmed ordinary-read path | Confirmed colocated indexed Alchemy use |
| --- | --- | --- |
| `api` | ENS/identity lookup, EIP-1271 wallet and CMS signatures, NextGen validation | NFT proxy and Rememes metadata validation |
| `discoverEnsLoop` | `ens.ts` / `ens-lookup.ts` reverse resolution | None in the reviewed ENS path |
| `refreshEnsLoop` | `ens.ts` / `ens-lookup.ts` reverse resolution | None in the reviewed ENS path |
| `delegationsLoop` | `delegations.ts` blocks/logs/transactions and ENS | None in the reviewed delegation path |
| `nftsLoop` | `nftsLoop/nfts.ts`, `memes-edition-size-floor.ts` contract reads | None in the reviewed contract-read path |
| `nftHistoryLoop` | `nft_history.ts` blocks/transactions/receipts | `getAssetTransfers` |
| `transactionsLoop` | `transaction_values.ts`, ENS | `transactions-discovery.service.ts` asset transfers |
| `nextgenContractLoop` | `nextgen/` blocks/logs/transactions/receipts/contracts | NextGen asset transfers |
| `tdhLoop` | `tdhLoop/tdh.ts` block/timestamp reads | None in the reviewed block-read path |
| `subscriptionsTopUpLoop` | `subscription_topups.ts` blocks | Subscription asset transfers |
| `mintAnnouncementsLoop` | `manifold-claim.service.ts` contract reads | None in the reviewed claim path |
| `artCurationNftWatchLoop` | `art-curation-token-watch.onchain.ts` contract reads | None in the reviewed on-chain path |
| `populateHistoricConsolidatedTdh` | Historical block timestamps | None in the reviewed timestamp path |

Keep the key on every existing consumer in this PR, including ordinary-only
paths that still construct Alchemy URLs. After migration, at least the indexed
API, NFT history, transaction, NextGen, subscription and `rememesLoop` paths
still need `ALCHEMY_API_KEY`. Absence of indexed use in a reviewed path is not
permission to remove credentials from an entire service without checking its
remaining callers. Shared imports alone are not evidence a loop executes every
imported capability; refresh the inventory for each caller-migration diff.

### Non-mainnet and explicit exceptions

- NextGen selectors retain mainnet, Sepolia and Goerli code paths via
  `NEXTGEN_CHAIN_ID`. API structured-wallet and CMS signature verification
  explicitly support chain IDs 1, 5 and 11155111.
- `SUBSCRIPTIONS_CHAIN_ID` can select Sepolia; delegation code has a Sepolia
  branch, although the current `DELEGATION_CONTRACT` selects mainnet.
- Testnet variables are independent and required only when the new provider is
  called for that chain. Goerli is retained for existing-code compatibility,
  not a claim that a live provider remains available. No supported Hoodi path
  was found; chain 560048 is rejected instead of being mapped to mainnet.
- `NFT_INDEXER_RPC` remains separate for external indexing and NFT link reads.
  Its capacity/ownership decision remains open; this PR does not collapse it.
- `trace_block`, the hard-coded 6529 ENS/trace fallback, and the legacy AWS
  Managed Blockchain `/rpc` proxy are unchanged and not implicitly qualified
  by this factory. Resolve their explicit policies in the later scoped work.

## Rollout and rollback

No service needs redeployment merely to merge this additive, unused foundation.
No secret provisioning or deployment was performed as part of implementation.
The configuration pass remains an operator prerequisite, not a completed step.

Before activating callers in PR 2, follow the parent plan's configuration
verification order: `api`, `discoverEnsLoop`, `refreshEnsLoop`,
`delegationsLoop`, `nftsLoop`, `nftHistoryLoop`, `transactionsLoop`,
`nextgenContractLoop`, `tdhLoop`, `subscriptionsTopUpLoop`,
`mintAnnouncementsLoop`, `artCurationNftWatchLoop`,
`populateHistoricConsolidatedTdh`. Refresh/redeploy only as needed to load and
verify configuration; never invoke the historical TDH job merely for a check.
Each subsequent migration PR must name its actual affected services and order.

Rollback before migration is removal/reversion of the unused foundation only;
existing routing and Alchemy credentials stay intact. After callers migrate,
removing the new configuration is unsafe: roll back the caller migration or
restore the prior URL instead. PR 2 and PR 3 remain separate work.
