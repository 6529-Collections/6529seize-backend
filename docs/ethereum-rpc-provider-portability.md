# Ethereum RPC Provider Portability

Status: Backend implementation planned; frontend implementation tracked separately

Owners: Backend and frontend

Canonical record: This document is the cross-repository source of truth for
the migration. The frontend-owned execution record is
[Ethereum RPC provider portability](https://github.com/6529-Collections/6529seize-frontend/blob/main/ops/workstreams/ethereum-rpc-provider-portability/README.md).

## Decision

All ordinary Ethereum mainnet JSON-RPC operations owned by the application
must use one server-side configuration value:

```text
ETHEREUM_RPC_URL
```

Initially, `ETHEREUM_RPC_URL` will point to an Alchemy Ethereum mainnet RPC
endpoint. Replacing Alchemy for ordinary calls must subsequently be a
configuration-only change: update this URL and redeploy the affected services.

For this decision, ordinary calls are:

- block number and block lookup;
- log lookup;
- transaction and transaction-receipt lookup;
- ENS resolution;
- contract code and read-only contract calls.

Alchemy-specific indexed products are not ordinary JSON-RPC and are not part
of the URL-only portability guarantee. They must remain isolated, named as
Alchemy dependencies, and continue to use `ALCHEMY_API_KEY` until separately
replaced:

- Alchemy NFT REST APIs;
- `alchemy_getAssetTransfers`.

`trace_block` is also outside the ordinary-call guarantee because it is a
non-standard RPC method. Its provider requirements and fallback behavior must
remain explicit.

## Why this boundary exists

The application no longer depends on the published `alchemy-sdk` package. The
backend instead has a local compatibility module at `src/alchemy-sdk.ts`.
However, that module still combines two different concerns:

1. standard Ethereum operations implemented through `ethers`; and
2. Alchemy-only indexed APIs implemented through Alchemy JSON-RPC and NFT REST
   endpoints.

Removing the external SDK therefore did not make runtime provider selection
configuration-only. Standard calls still derive Alchemy URLs from
`ALCHEMY_API_KEY` in several paths, while other paths use hard-coded or
separately configured RPC endpoints.

## Current state

### Backend

- `src/rpc-provider.ts` exposes an `ethers.JsonRpcProvider`, but its ordinary
  provider URL is constructed from `ALCHEMY_API_KEY` and an Alchemy hostname.
- `src/alchemy.ts` constructs the local Alchemy compatibility client and also
  exposes Alchemy-derived RPC URL helpers.
- `src/alchemy-sdk.ts` implements standard block, log, transaction, receipt,
  and ENS operations alongside `alchemy_getAssetTransfers` and Alchemy NFT REST
  operations.
- Some callers instantiate providers from `getRpcUrl()` or
  `getRpcUrlFromNetwork()` instead of using the shared provider factory.
- `src/external-indexing/external-indexer-rpc.ts` uses the separate
  `NFT_INDEXER_RPC` setting.
- `src/transaction_values.ts` uses non-standard `trace_block` and has a
  provider-specific fallback path.
- The API exposes a legacy AWS Managed Blockchain proxy under `/rpc`; its
  ownership and consumers must be established before it is retained, migrated,
  or removed.

### Frontend

- [Frontend PR #3911](https://github.com/6529-Collections/6529seize-frontend/pull/3911)
  implements the shared server-only `ETHEREUM_RPC_URL` boundary and deployment
  configuration. Implementation does not imply deployment; consult the PR and
  frontend execution record for current rollout state.
- Active `/api/alchemy/*` routes and Open Graph NFT metadata fallback code use
  Alchemy NFT REST APIs. Those are indexed-product dependencies and remain in
  scope for `ALCHEMY_API_KEY`, not `ETHEREUM_RPC_URL`.
- The unused `services/alchemy-api.ts` facade, implementation modules
  `services/alchemy/{index,collections,owner-nfts,tokens}.ts`, and orphaned test
  were removed in merged
  [frontend PR #3915](https://github.com/6529-Collections/6529seize-frontend/pull/3915).
- `services/alchemy/types.ts` and `services/alchemy/utils.ts` are active shared
  modules and are not dead code.

## Target architecture

```mermaid
flowchart LR
  BE[Backend ordinary reads] --> RPC[ETHEREUM_RPC_URL]
  FE[Frontend server-side ordinary reads] --> RPC
  RPC --> Provider[Configured Ethereum RPC provider]

  BEIndexed[Backend indexed features] --> AlchemyIndexed[Alchemy indexed APIs]
  FEIndexed[Frontend NFT metadata features] --> AlchemyIndexed
  AlchemyKey[ALCHEMY_API_KEY] --> AlchemyIndexed

  Trace[trace_block consumers] --> TraceProvider[Explicit trace-capable provider]
```

The application must not infer the ordinary RPC URL from
`ALCHEMY_API_KEY`. Code using the ordinary provider must not import Alchemy
types, construct Alchemy hostnames, or rely on Alchemy response extensions.

`ETHEREUM_RPC_URL` is server-only configuration. It must not be exposed as a
`NEXT_PUBLIC_*` value or shipped to browser bundles.

## Backend implementation plan

### Delivery split: three implementation PRs

Keep [backend PR #1979](https://github.com/6529-Collections/6529seize-backend/pull/1979)
as the documentation-only plan/tracker. Implement the migration in three
sequential PRs, each reviewable and deployable after its prerequisites. Add
their links and completion evidence here as they are created and completed.
Implementation PR 1 is tracked in
[backend PR #1985](https://github.com/6529-Collections/6529seize-backend/pull/1985).
Parts 2 and 3 do not have implementation PRs yet.

#### Implementation PR 1: configuration and shared provider

Implementation opened: [PR #1985](https://github.com/6529-Collections/6529seize-backend/pull/1985).
Its [foundation record](https://github.com/6529-Collections/6529seize-backend/blob/agent-prxt/ethereum-rpc-foundation/ops/workstreams/ethereum-rpc-foundation/README.md)
documents the implemented configuration contract, source-derived consumer
inventory, rollout prerequisites and exceptions.

- Code delivered: additive lazy ethers provider with mainnet, Sepolia and
  Goerli URL selection, safe validation, chain checks, samples and focused
  provider/environment-loading coverage. Existing callers remain unchanged.
- Existing wiring reused: Lambda loops already load every key from regional
  Secrets Manager `prod/lambdas`; the API uses that loader when
  `API_LOAD_SECRETS=true`. No duplicate Actions secrets or per-Lambda URL
  fields are introduced. Alternative API runtime configuration must be
  provisioned through its existing path.
- Still pending: provision and verify runtime values before part 2. No secrets
  were provisioned and no deployment was performed. Opening the implementation
  PR does not mark the configuration rollout or caller migration complete.

Scope and completion criteria:

- Add `ETHEREUM_RPC_URL` validation, environment samples, service configuration
  wiring, and an additive provider-neutral factory with focused tests.
- Inventory supported non-mainnet chains and the services requiring each
  credential. Document explicit chain configuration; never send testnet reads
  to the mainnet URL.
- Preserve all existing caller routing in this PR. Do not repoint the existing
  shared factory while introducing the new boundary, since that would switch
  live callers before the configuration pass finishes.
- Provision and verify configuration on all affected services before PR 2
  activates the new path. Keep `ALCHEMY_API_KEY` for current consumers.

Completion: configuration is available without changing provider behaviour,
and the unused new factory is covered for valid/missing/invalid configuration
and chain selection. Once callers migrate, missing configuration must fail
clearly rather than silently reconstructing an Alchemy URL.

#### Implementation PR 2: straightforward ordinary reads

- Migrate ENS, wallet-signature and other contract checks, block and log
  lookups in the API and simpler background jobs to the new shared boundary.
- Preserve existing retry, timeout, caching, null-result and numeric-conversion
  semantics, with focused provider-boundary and caller regression coverage.
- Keep mixed transaction/NFT indexing workflows on their existing paths until
  PR 3. Shared-helper changes must not accidentally migrate those consumers;
  include the complete consumer graph in the scope and deployment inventory.

Completion: the selected ordinary callers work through `ETHEREUM_RPC_URL`
without an Alchemy key dependency. Document exactly which callers remain for
PR 3; partial migration is not full backend portability.

#### Implementation PR 3: mixed indexing workflows and cleanup

- Split transaction/NFT history, NextGen and subscription workflows so ordinary
  lookups use `ETHEREUM_RPC_URL`, while NFT REST calls and
  `alchemy_getAssetTransfers` remain on the Alchemy indexed client.
- Preserve ingestion results, pagination, checkpoints, retry behaviour and
  value conversions. Test both paths together, including failure cases, so
  separating providers does not skip or duplicate indexed work.
- Isolate `trace_block` behind an explicit trace-capable provider policy;
  tracing is not part of the ordinary-RPC compatibility promise.
- Remove obsolete ordinary-RPC helpers and compatibility methods only after
  their callers have migrated. Move neutral types out of the Alchemy module.
  Unlike the deleted FE facade, backend `src/alchemy-sdk.ts` is actively used:
  retain or extract its indexed capabilities, rather than deleting it wholesale.

Completion: all ordinary callers covered by this decision use the canonical
boundary, indexed Alchemy operations remain functional, and the acceptance
criteria below are met with explicit dispositions for exceptions.

#### Why this split and what stays separate

Configuration first avoids switching services before their runtime values are
available. Separating simpler reads from mixed indexing keeps review and
rollback focused; the latter carries the greater risk of changing persisted
ingestion results. Each implementation PR must list all affected deployables,
including indirect consumers of shared code, and its deployment/rollback plan.

Resolve whether `NFT_INDEXER_RPC` is an intentional separate capacity boundary
before claiming complete ordinary-RPC convergence. If retained, document the
exception explicitly rather than claiming one URL controls those reads too.

Investigate legacy `/rpc` consumers separately. Any removal or change of its
public proxy contract belongs in a separate, explicitly scoped PR once its
consumers are known; it must not block unrelated server-read migration. This
is not a fourth mandatory implementation PR unless that investigation requires
a change.

### 1. Establish the configuration contract

- Add `ETHEREUM_RPC_URL` to backend environment schemas, samples, deployment
  configuration, and every deployable service that performs ordinary mainnet
  reads.
- Keep `ALCHEMY_API_KEY` only on services that call an Alchemy indexed API.
- Fail clearly when a required RPC URL is absent. After rollout, do not silently
  reconstruct an Alchemy URL as a fallback.
- Inventory non-mainnet calls before implementation. A single mainnet URL must
  not be reused for Sepolia, Goerli, Hoodi, or another chain. If those calls
  remain required, give them explicit provider-neutral configuration rather
  than deriving Alchemy hostnames from `ALCHEMY_API_KEY`.

### 2. Make the shared ordinary provider Alchemy-independent

- Change the shared provider factory to construct and cache the mainnet
  provider from `ETHEREUM_RPC_URL`.
- Move provider-neutral network identifiers and response types out of the
  Alchemy compatibility module where importing them would otherwise preserve a
  false Alchemy dependency.
- Preserve the retry, timeout, null-result, and numeric-conversion behavior on
  which existing callers rely.

### 3. Migrate ordinary callers

- Route block numbers, blocks, logs, transactions, receipts, ENS, contract
  code, and contract reads through the shared provider boundary.
- Replace direct uses of Alchemy-derived `getRpcUrl()` and
  `getRpcUrlFromNetwork()` for ordinary calls.
- Split mixed workflows so their ordinary lookups use the shared provider even
  when the same workflow still uses `alchemy_getAssetTransfers` or an Alchemy
  NFT endpoint.
- Update names, logs, tests, and mocks that call a standard provider “Alchemy”
  after it becomes provider-neutral.

### 4. Isolate provider-specific capabilities

- Retain a narrowly named Alchemy indexed client for NFT REST operations and
  `alchemy_getAssetTransfers`.
- Do not place standard RPC methods on that client after their callers migrate.
- Treat `trace_block` as a capability-specific provider. Verify that the
  intended initial endpoint supports it, retain an explicit fallback if needed,
  and document the failure behavior independently of ordinary RPC.
- Decide whether `NFT_INDEXER_RPC` intentionally represents a different
  reliability/capacity class. If it does, retain and document it. If it does
  not, migrate its ordinary reads to `ETHEREUM_RPC_URL`.

### 5. Resolve the legacy `/rpc` surface

- Identify current internal and external consumers of the AWS Managed
  Blockchain `/rpc` proxy.
- Remove it if unused. If it is still required, document its purpose and decide
  whether it should proxy `ETHEREUM_RPC_URL` or remain an explicitly separate
  integration.
- Do not treat this decision as a blocker for migrating unrelated ordinary
  server-side reads.

## Frontend implementation plan

The frontend owns a concise execution record in its `ops/workstreams/`
directory. Its implementation scope is:

1. Delete the unused `services/alchemy-api.ts` facade, the unused
   `services/alchemy/{index,collections,owner-nfts,tokens}.ts` implementations,
   and their orphaned test.
2. Retain `services/alchemy/types.ts` and `services/alchemy/utils.ts` while
   production code imports them.
3. Add one server-only provider-neutral construction path for ordinary
   mainnet reads and configure it with `ETHEREUM_RPC_URL`.
4. Migrate server-owned Open Graph block, ENS, and contract reads away from
   default and hard-coded transports.
5. Keep browser wallet transports and transaction submission outside this
   server-RPC decision. Wallet libraries must continue to follow their own
   chain and connector contracts.
6. Keep active Alchemy NFT routes and metadata fallbacks isolated and backed by
   `ALCHEMY_API_KEY` until a separate indexed-data replacement is selected.

## Rollout

### Phase 1: provider-neutral code, Alchemy endpoint

The implementation must refresh this source-derived inventory immediately
before changing runtime code. At the time of this decision, these backend
deployables contain confirmed ordinary-RPC call paths and therefore require
`ETHEREUM_RPC_URL`:

| Deployment | Ordinary-RPC responsibility |
| --- | --- |
| `api` | ENS resolution, wallet-signature and profile-CMS contract checks, NextGen validation, and other request-time contract reads |
| `discoverEnsLoop` | ENS reverse resolution for newly discovered wallets |
| `refreshEnsLoop` | ENS reverse-resolution refreshes |
| `delegationsLoop` | Block, log, transaction, and ENS reads |
| `nftsLoop` | Block and contract reads, including edition-size calculation |
| `nftHistoryLoop` | Block, transaction, and receipt reads alongside Alchemy asset transfers |
| `transactionsLoop` | Transaction, receipt, ENS, and trace reads alongside Alchemy asset transfers |
| `nextgenContractLoop` | Block, log, transaction, receipt, ENS, contract, and trace reads alongside Alchemy asset transfers |
| `tdhLoop` | Block and contract reads |
| `subscriptionsTopUpLoop` | Block reads alongside Alchemy asset transfers |
| `mintAnnouncementsLoop` | Manifold contract reads |
| `artCurationNftWatchLoop` | Art-curation contract reads |
| `populateHistoricConsolidatedTdh` | Manual historical block-timestamp reads |

`nftLinkRefresherLoop` is conditional. Its contract reads currently use
`NFT_INDEXER_RPC`; add it to this inventory only if the implementation decision
is to collapse that separate capacity boundary into `ETHEREUM_RPC_URL`.

The backend rollout is two ordered passes. Complete the entire configuration
pass before switching any runtime caller:

1. In local/development, staging, and production, provision
   `ETHEREUM_RPC_URL` with the current Alchemy mainnet endpoint. Do not remove
   `ALCHEMY_API_KEY` from indexed-product consumers.
2. Add environment wiring to each confirmed deployment above, then deploy the
   configuration-only change sequentially in this order: `api`,
   `discoverEnsLoop`, `refreshEnsLoop`, `delegationsLoop`, `nftsLoop`,
   `nftHistoryLoop`, `transactionsLoop`, `nextgenContractLoop`, `tdhLoop`,
   `subscriptionsTopUpLoop`, `mintAnnouncementsLoop`,
   `artCurationNftWatchLoop`, and `populateHistoricConsolidatedTdh`.
3. Verify each deployed service received the configuration without changing
   its provider behavior. Do not invoke `populateHistoricConsolidatedTdh`
   merely to verify configuration.
4. In the runtime pass, deliver implementation PR 2 before PR 3. For each PR,
   refresh the affected-service inventory and deploy its affected subset in
   the order above, adjusted for any verified service dependencies. Shared
   helper changes may require redeploying a service in both PRs. Verify ordinary
   reads against the configured Alchemy endpoint after each deploy and verify
   any colocated indexed Alchemy path still uses `ALCHEMY_API_KEY`.
5. If `nftLinkRefresherLoop` joins the canonical boundary, deploy it after the
   confirmed sequence and before removing `NFT_INDEXER_RPC` from any
   environment.
6. Track frontend implementation and deployment independently through frontend
   PR #3911. Its server-owned RPC boundary does not depend on the backend
   migration completing; the previous FE-after-BE ordering is superseded.
7. Remove obsolete Alchemy-derived ordinary RPC helpers only after all backend
   and frontend callers have moved.

### Phase 2: URL-only provider replacement

1. Qualify the candidate endpoint for supported standard methods, chain ID,
   archive depth, log range limits, rate limits, timeouts, and production load.
2. Qualify `trace_block` separately; it is not implied by standard Ethereum
   JSON-RPC support.
3. Change `ETHEREUM_RPC_URL` and redeploy without application-code changes.
4. Monitor correctness, latency, throttling, and ingestion lag; roll back by
   restoring the previous URL if necessary.

## Acceptance criteria

- Changing the provider for ordinary mainnet calls requires changing only
  `ETHEREUM_RPC_URL` and redeploying affected services.
- Ordinary-call code contains no Alchemy hostname construction and requires no
  Alchemy API key.
- Blocks, logs, transactions, receipts, ENS, contract code, and contract reads
  have focused provider-boundary coverage.
- Alchemy NFT REST and `alchemy_getAssetTransfers` dependencies are visibly
  isolated and remain functional.
- `trace_block`, non-mainnet RPC, `NFT_INDEXER_RPC`, and `/rpc` have explicit
  documented dispositions rather than accidental fallback behavior.
- Frontend browser bundles do not contain `ETHEREUM_RPC_URL`.
- The unused frontend Alchemy service facade and implementations are removed,
  while active types and utilities remain.

## Non-goals

- Replacing Alchemy NFT REST or `alchemy_getAssetTransfers` in this migration.
- Removing `ALCHEMY_API_KEY` while indexed Alchemy products still use it.
- Routing wallet writes or user-selected wallet transports through the
  application server.
- Assuming every Ethereum provider supports tracing, indexed history, archive
  reads, or unrestricted log ranges.

## Open decisions to close during implementation

- Which deployable services require `ETHEREUM_RPC_URL` and which require only
  `ALCHEMY_API_KEY`?
- Which non-mainnet chains remain supported by server-owned ordinary calls, and
  what are their explicit provider-neutral configuration names?
- Does `NFT_INDEXER_RPC` represent a deliberately separate provider/capacity
  boundary?
- Which provider is authoritative for `trace_block`?
- Does the legacy AWS Managed Blockchain `/rpc` API have any supported
  consumers?
