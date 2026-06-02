# Architecture Overview

This backend is a serverless, database-centered TypeScript system for 6529.io.
The main runtime pieces are:

- A single public API Lambda (`seizeAPI`) running Express.
- Many independently deployed background Lambdas for chain ingestion, derived data, media processing, notifications, and operations.
- MySQL as the source of truth.
- Redis as shared cache, rate-limit, dedupe, and short-lived coordination storage.
- SQS and EventBridge as the async execution fabric.
- S3, CloudFront, Arweave, Ethereum/RPC providers, Firebase, Sentry, CloudWatch, Discord, and SNS around the core.

## High-Level Diagram

This is the compact map. Lambda boxes are intentionally just service names; trigger type is shown by the surrounding group or the queue/topic feeding the Lambda. The tables below carry the longer descriptions so the diagram stays readable.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 58, "curve": "basis"}} }%%
flowchart TD
  Client["Client / web app"] --> APIGW["API Gateway<br/>HTTP + WebSocket"]
  APIGW --> SeizeAPI["seizeAPI"]

  SeizeAPI --> Auth["auth, routes,<br/>WebSockets, OpenAPI"]
  SeizeAPI --> ReadPool["API read pool"]
  SeizeAPI --> WritePool["API write pool"]
  ReadPool --> MySQL["MySQL / RDS"]
  WritePool --> MySQL
  SeizeAPI --> Redis["Redis"]
  SeizeAPI --> S3["S3"]
  SeizeAPI --> AiRpc["AI / RPC / webhooks"]

  subgraph Scheduled["Scheduled Lambdas (EventBridge)"]
    direction TB
    EventBridge["EventBridge schedules"] --> NftsLoop["nftsLoop"]
    NftsLoop ~~~ TransactionsLoop["transactionsLoop"]
    TransactionsLoop ~~~ NftOwnersLoop["nftOwnersLoop"]
    NftOwnersLoop ~~~ NftHistoryLoop["nftHistoryLoop"]
    NftHistoryLoop ~~~ DelegationsLoop["delegationsLoop"]
    DelegationsLoop ~~~ NextgenContractLoop["nextgenContractLoop"]
    NextgenContractLoop ~~~ NextgenMetadataLoop["nextgenMetadataLoop"]
    NextgenMetadataLoop ~~~ ExternalSnapshotLoop["externalCollectionSnapshottingLoop"]
    ExternalSnapshotLoop ~~~ ExternalLiveTailLoop["externalCollectionLiveTailingLoop"]
    ExternalLiveTailLoop ~~~ TransactionsProcessingLoop["transactionsProcessingLoop"]
    TransactionsProcessingLoop ~~~ TdhLoop["tdhLoop"]
    TdhLoop ~~~ TdhHistoryLoop["tdhHistoryLoop"]
    TdhHistoryLoop ~~~ OwnersBalancesLoop["ownersBalancesLoop"]
    OwnersBalancesLoop ~~~ AggregatedActivityLoop["aggregatedActivityLoop"]
    AggregatedActivityLoop ~~~ MarketStatsLoop["marketStatsLoop"]
    MarketStatsLoop ~~~ RateEventProcessingLoop["rateEventProcessingLoop"]
    RateEventProcessingLoop ~~~ WaveDecisionExecutionLoop["waveDecisionExecutionLoop"]
    WaveDecisionExecutionLoop ~~~ WaveLeaderboardSnapshotterLoop["waveLeaderboardSnapshotterLoop"]
    WaveLeaderboardSnapshotterLoop ~~~ XTdhGrantsReviewerLoop["xTdhGrantsReviewerLoop"]
    XTdhGrantsReviewerLoop ~~~ SubscriptionsDaily["subscriptionsDaily"]
    SubscriptionsDaily ~~~ SubscriptionsTopUpLoop["subscriptionsTopUpLoop"]
    SubscriptionsTopUpLoop ~~~ DiscoverEnsLoop["discoverEnsLoop"]
    DiscoverEnsLoop ~~~ RefreshEnsLoop["refreshEnsLoop"]
    RefreshEnsLoop ~~~ EthPriceLoop["ethPriceLoop"]
    EthPriceLoop ~~~ MintAnnouncementsLoop["mintAnnouncementsLoop"]
    MintAnnouncementsLoop ~~~ ArtCurationNftWatchLoop["artCurationNftWatchLoop"]
    ArtCurationNftWatchLoop ~~~ RememesLoop["rememesLoop"]
    RememesLoop ~~~ RoyaltiesLoop["royaltiesLoop"]
    RoyaltiesLoop ~~~ DbDumpsDaily["dbDumpsDaily"]
    DbDumpsDaily ~~~ NextgenMediaUploader["nextgenMediaUploader"]
    NextgenMediaUploader ~~~ NextgenMediaImageResolutions["nextgenMediaImageResolutions"]
  end

  subgraph Queues["Queue and topic triggered Lambdas"]
    direction TB
    WaveDecisionExecutionLoop --> ClaimsBuilderQueue["SQS: claims-builder"] --> ClaimsBuilder["claimsBuilder"]
    SeizeAPI --> ClaimsMediaQueue["SQS: claims-media-arweave-upload"] --> ClaimsMediaArweaveUploader["claimsMediaArweaveUploader"]
    NftsLoop --> S3UploaderQueue["SQS: s3-uploader-jobs"] --> S3Uploader["s3Uploader"]
    SeizeAPI --> AttachOrchestrationQueue["SQS: attachments-orchestration"] --> AttachmentsOrchestrator["attachmentsOrchestrator"]
    AttachmentsOrchestrator --> AttachProcessingQueue["SQS: attachments-processing"] --> AttachmentsProcessor["attachmentsProcessor"]
    SeizeAPI --> NftLinkRefreshQueue["SQS: nft-link-refreshes"] --> NftLinkRefresherLoop["nftLinkRefresherLoop"]
    NftLinkRefresherLoop --> NftLinkPreviewQueue["SQS: nft-link-media-previews"] --> NftLinkMediaPreviewLoop["nftLinkMediaPreviewLoop"]
    SeizeAPI --> PushQueue["SQS: firebase-push-notifications"] --> PushNotificationsHandler["pushNotificationsHandler"]
    TdhLoop --> TdhDoneTopic["SNS: tdh-calculation-done.fifo"]
    TdhDoneTopic --> XTdhQueue["SQS: xtdh-start.fifo"] --> XTdhLoop["xTdhLoop"]
    TdhDoneTopic --> OverRatesQueue["SQS: over-rates-revocation-start.fifo"] --> OverRatesRevocationLoop["overRatesRevocationLoop"]
  end

  subgraph RequestEventManual["Request, event, edge, SNS, and manual Lambdas"]
    direction TB
    CloudFront["CloudFront"] --> MediaResizerLoop["mediaResizerLoop"]
    CloudFront --> NextgenMediaProxyInterceptor["nextgenMediaProxyInterceptor"]
    S3 --> DropsVideoCreatedRule["S3 Object Created: drops/"] --> DropVideoConversionInvokerLoop["dropVideoConversionInvokerLoop"]
    S3 --> AttachmentObjectCreatedRule["S3 Object Created: attachments"] --> AttachmentsOrchestrator
    Operator["operator / deploy workflow"] --> DbMigrationsLoop["dbMigrationsLoop"]
    Operator --> CustomReplayLoop["customReplayLoop"]
    Operator --> PopulateHistoricConsolidatedTdh["populateHistoricConsolidatedTdh"]
    Operator --> TeamLoop["teamLoop"]
    CloudwatchTopic["SNS: cloudwatch-alarms"] --> CloudwatchAlarmsToDiscordLoop["cloudwatchAlarmsToDiscordLoop"]
  end

  BackgroundWorkers["background Lambda runtime"] --> LambdaRuntime["doInDbContext runtime"]
  LambdaRuntime --> MySQL
  LambdaRuntime --> Redis
  LambdaRuntime --> Ops["Sentry / CloudWatch / Discord"]

  S3Uploader --> S3
  AttachmentsProcessor --> S3
  NftLinkMediaPreviewLoop --> S3
  ClaimsMediaArweaveUploader --> Arweave["Arweave"]
  PushNotificationsHandler --> Firebase["Firebase"]
  DropVideoConversionInvokerLoop --> MediaConvert["MediaConvert"]
```

## Lambda Inventory

### Scheduled Lambdas (EventBridge)

| Lambda | Purpose |
|---|---|
| `nftsLoop` | Discover, refresh, and audit NFTs. |
| `transactionsLoop` | Index MEMES, Gradients, and Meme Lab transfers. |
| `nftOwnersLoop` | Maintain current owner balance snapshots. |
| `nftHistoryLoop` | Maintain ownership history. |
| `delegationsLoop` | Sync delegation.cash and consolidation data. |
| `nextgenContractLoop` | Index NextGen contract events. |
| `nextgenMetadataLoop` | Refresh NextGen metadata. |
| `externalCollectionSnapshottingLoop` | Snapshot external collection ownership. |
| `externalCollectionLiveTailingLoop` | Live-tail external collection transfers. |
| `transactionsProcessingLoop` | Normalize raw transactions into processed state. |
| `tdhLoop` | Calculate TDH and publish TDH completion. |
| `tdhHistoryLoop` | Write historical TDH snapshots. |
| `ownersBalancesLoop` | Project owner balance aggregates. |
| `aggregatedActivityLoop` | Calculate activity aggregates. |
| `marketStatsLoop` | Aggregate market stats for MEMES, Lab, Gradients, and NextGen. |
| `rateEventProcessingLoop` | Process DB-backed rating events. |
| `waveDecisionExecutionLoop` | Execute wave decisions and enqueue claim builds. |
| `waveLeaderboardSnapshotterLoop` | Snapshot wave leaderboards. |
| `xTdhGrantsReviewerLoop` | Review xTDH grants. |
| `subscriptionsDaily` | Process daily subscription work. |
| `subscriptionsTopUpLoop` | Process subscription top-ups. |
| `discoverEnsLoop` | Discover ENS names. |
| `refreshEnsLoop` | Refresh known ENS names. |
| `ethPriceLoop` | Snapshot ETH price. |
| `mintAnnouncementsLoop` | Publish mint announcements. |
| `artCurationNftWatchLoop` | Watch curated NFT state. |
| `rememesLoop` | Refresh rememes S3 files and metadata. |
| `royaltiesLoop` | Refresh royalty state. |
| `dbDumpsDaily` | Create daily database dumps. |
| `nextgenMediaUploader` | Upload NextGen media. |
| `nextgenMediaImageResolutions` | Generate NextGen image resolutions. |

### Triggered Lambdas

| Lambda | Trigger | Purpose |
|---|---|---|
| `api` / `seizeAPI` | API Gateway HTTP/WebSocket | Public REST API and WebSocket boundary. |
| `claimsBuilder` | SQS `claims-builder` | Build minting claims from winning drops. |
| `claimsMediaArweaveUploader` | SQS `claims-media-arweave-upload` | Upload claim media and metadata to Arweave. |
| `s3Uploader` | SQS `s3-uploader-jobs` | Mirror, compress, and upload NFT media. |
| `attachmentsOrchestrator` | SQS `attachments-orchestration` and S3 object-created event | Find uploaded attachment objects, retry, and enqueue processing. |
| `attachmentsProcessor` | SQS `attachments-processing` | Scan/process attachments. |
| `nftLinkRefresherLoop` | SQS `nft-link-refreshes` | Resolve external NFT links. |
| `nftLinkMediaPreviewLoop` | SQS `nft-link-media-previews` | Generate media previews for NFT links. |
| `pushNotificationsHandler` | SQS `firebase-push-notifications` | Deliver Firebase push notifications. |
| `xTdhLoop` | SNS `tdh-calculation-done.fifo` via SQS `xtdh-start.fifo` | Recalculate xTDH after TDH finishes. |
| `overRatesRevocationLoop` | SNS `tdh-calculation-done.fifo` via SQS `over-rates-revocation-start.fifo` | Revoke over-rates after TDH changes. |
| `mediaResizerLoop` | CloudFront/request path | Resize images on demand. |
| `nextgenMediaProxyInterceptor` | Lambda@Edge / CloudFront request | Provide NextGen metadata fallback. |
| `dropVideoConversionInvokerLoop` | S3 object-created event for `drops/` | Invoke MediaConvert for uploaded drop videos. |
| `cloudwatchAlarmsToDiscordLoop` | SNS `cloudwatch-alarms` | Post CloudWatch alarms to Discord. |

### Manual Or One-Off Lambdas

| Lambda | Purpose |
|---|---|
| `dbMigrationsLoop` | TypeORM entity synchronization, usually run from deploy workflow. |
| `customReplayLoop` | Controlled replay job. |
| `populateHistoricConsolidatedTdh` | Historic consolidated TDH backfill. |
| `teamLoop` | Team CSV and Arweave upload. |

## Runtime Shape

The API Lambda is the public synchronous boundary. It initializes local config or AWS secrets, opens MySQL read/write pools, initializes Redis, configures Passport JWT authentication, registers all routers, and then serves HTTP through `serverless-http`. The same handler also branches on API Gateway WebSocket route keys for `$connect`, `$disconnect`, and `$default` messages.

Background Lambdas use a shared `doInDbContext` wrapper. That wrapper prepares environment/secrets, initializes TypeORM-backed DB access, initializes Redis, runs the job, then disconnects. This gives loop jobs a consistent lifecycle and keeps each worker independently deployable.

MySQL is the integration contract between nearly all modules. API routes, scheduled pollers, queue workers, and derived-data loops all read and write shared tables. Redis is secondary and mostly disposable: API request cache, rate limiting, webhook dedupe, locks, and selected feature caches can fail open or be repopulated from MySQL.

## Main Data Flows

1. Client requests enter through API Gateway and land in `seizeAPI`.
2. The API validates input, authenticates JWT or anonymous context, reads/writes MySQL, uses Redis for cache/rate limiting, and sometimes publishes SQS work.
3. Scheduled ingestion Lambdas poll Ethereum/RPC/Alchemy/Etherscan, normalize chain state, and write canonical rows into MySQL.
4. Derived-data Lambdas read canonical tables and write projections such as TDH, owner balances, aggregated activity, wave decisions, leaderboards, metrics, and reputation aggregates.
5. SQS workers handle slow or retryable side effects through named queues: claim building, claim media Arweave uploads, S3 media mirroring, attachment orchestration/processing, NFT link resolution/previews, xTDH recalculation, and Firebase push notifications.
6. S3 and CloudFront serve media. Some paths have specialized Lambda behavior: on-demand resizing, video conversion, and NextGen metadata placeholder interception.
7. Operational signals flow to Sentry, CloudWatch alarms, Discord, and SNS.

## API Boundary

The API is organized by domain routers under `src/api-serverless/src`. The OpenAPI file defines the public contract and generated models, while route implementation remains manual. This gives strong response model consistency without forcing generated routing.

Important API responsibilities:

- Authentication and refresh-token flows.
- Public read APIs for NFTs, TDH, waves, drops, profiles, community metrics, subscriptions, and notifications.
- Authenticated social writes: drops, votes, reactions, curations, subscriptions, groups, proxies, minting claims, and push settings.
- Upload preparation and multipart completion for drop media, wave media, distribution photos, and attachments.
- WebSocket connection registration and real-time wave-related messages.
- Operational endpoints such as health, docs, RPC/proxy routes, webhooks, and deploy-related routes.

## Database Boundary

There are two DB access modes:

- API mode uses mysql read/write pools. Simple SQL classification routes `INSERT`, `UPDATE`, `DELETE`, and `REPLACE` to the write pool; other queries default to the read pool unless forced.
- Loop mode uses TypeORM initialization and the shared `SqlExecutor` abstraction. Schema ownership is entities-first: add or update TypeORM entity classes, export them from `src/entities/entities.ts`, and let `dbMigrationsLoop` run entity synchronization. Do not create SQL migrations for schema changes unless explicitly requested; migrations are reserved for one-off data work or views.

The core architectural choice is that MySQL is both the system of record and the internal integration layer. This keeps the system understandable, but it makes table contracts, migrations, backfills, indexes, and worker idempotency especially important.

## Async Processing

There are three async patterns:

- EventBridge scheduled pollers: periodic ingestion, aggregation, refresh, and operational jobs.
- SQS workers: retryable side effects and heavier processing.
- DB-backed event processing: the `events` table stores processable events, and `rateEventProcessingLoop` locks and dispatches them to listener implementations.

Most long-running scheduled jobs have reserved concurrency set low, usually `1`, which protects shared tables from concurrent writer races. SQS workers use queue visibility timeouts, DLQs, and batch failure reporting where configured.

## Drops -> Minting Claim Queue Flows

This is the concrete path where a winning drop becomes a minting claim. It is also representative of how this codebase uses SQS: synchronous code commits the durable state change first, then publishes a small message to a purpose-built queue, and the worker re-reads the full entity from MySQL before doing expensive or external work.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 44, "curve": "basis"}} }%%
flowchart TD
  WaveDecision["waveDecisionExecutionLoop"] --> DecisionTx["commit winning drop decision"]
  DecisionTx --> ClaimBuildPublisher["enqueueClaimBuild(drop_id)"]
  ClaimBuildPublisher --> ClaimsBuilderSqs["SQS: claims-builder"]
  ClaimsBuilderSqs --> ClaimsBuilder["claimsBuilder"]
  ClaimsBuilder --> MintingClaimsService["create minting claim if missing"]
  MintingClaimsService --> MintingClaimsTable["minting claim tables"]

  MintingClaimsTable -. "admin media upload path" .-> AdminClient["Distribution admin client"]
  AdminClient --> UploadEndpoint["seizeAPI upload endpoint"]
  UploadEndpoint --> UploadLock["lock claim row"]
  UploadLock --> MediaPublisher["enqueueClaimMediaArweaveUpload"]
  MediaPublisher --> MediaSqs["SQS: claims-media-arweave-upload"]
  MediaSqs --> MediaUploader["claimsMediaArweaveUploader"]
  MediaUploader --> FetchClaim["fetch claim"]
  FetchClaim --> ArweaveUpload["upload to Arweave"]
  ArweaveUpload --> UpdateClaim["store Arweave tx ids"]
  UpdateClaim --> PriorityAlert["priority alert on failure path"]
```

Important details:

- `claims-builder` messages are produced by `waveDecisionExecutionLoop` after the wave decision has been committed. If enqueueing fails, the decision remains committed and a priority alert is sent.
- `claimsBuilder` consumes `{ drop_id }`, then calls the minting-claim service to create the missing claim from the winning drop.
- `claims-media-arweave-upload` messages are produced by the API only after the claim row is locked with `media_uploading=true`.
- If media upload enqueueing fails, the API tries to roll `media_uploading` back to `false`.
- `claimsMediaArweaveUploader` consumes `{ contract, claim_id }`, re-fetches the claim, uploads media and metadata to Arweave, then stores Arweave transaction ids back on the claim row.

## Deployment Model

Deployment is service-by-service through the generated GitHub Actions workflow. The workflow exposes `api` and each Lambda service as a deploy choice.

Most Lambdas deploy through each service's `serverless.yaml`. The API is packaged from `src/api-serverless` and deployed by direct AWS Lambda update commands as `seizeAPI`. `mediaResizerLoop` also has a direct Lambda update path. `nextgenMediaProxyInterceptor` deploys as a Lambda@Edge version and updates CloudFront associations through its shell script.

Typical deployment order when schema or generated API contracts change:

1. `dbMigrationsLoop` if TypeORM entities changed, or if an explicit data/view migration was requested.
2. Producer Lambdas that start writing new fields or queue payloads.
3. Consumer Lambdas that read those new fields or consume those payloads.
4. `api` when routes, OpenAPI models, auth behavior, upload behavior, or user-facing responses changed.

For a documentation-only change, no Lambda redeploy is required.

## Architecture Notes

The strongest part of the architecture is its operational decomposition. Expensive, slow, and retryable work is mostly outside the request path, and the loop structure makes individual jobs independently deployable.

The biggest tradeoff is the DB-centered coupling. Many services share tables directly, so changes need to be treated as cross-service contracts even when they look local. The safest pattern is additive schema changes first, backward-compatible writers/readers second, and cleanup only after all dependent Lambdas are deployed.

The API Lambda has a broad blast radius. It is pragmatic and easy to route through one entrypoint, but it owns many unrelated concerns: public REST, auth, WebSocket handling, webhooks, upload preparation, docs, health, and proxy endpoints. Continued growth may eventually justify splitting high-risk or high-traffic boundaries.

Redis should remain treated as an optimization and coordination layer, not a source of truth. The current design mostly follows that rule.

Media and edge processing are the most heterogeneous deployment area. S3, CloudFront, MediaConvert, Lambda@Edge, native modules, and specialized build packaging all meet there, so changes in this area need more deployment and runtime verification than ordinary DB/API changes.
