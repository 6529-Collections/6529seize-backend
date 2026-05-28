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

These diagrams are split into stacked, top-to-bottom maps so they render naturally in a browser.
Every deployable Lambda service has its own box.
Lambda boxes use explicit `Trigger:`, `Does:`, and sometimes `Scope:` lines instead of unlabeled shorthand.
Some inventory diagrams use invisible Mermaid layout links to keep long service lists vertical; those links do not imply execution order.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 44, "curve": "basis"}} }%%
flowchart TD
  Client["Client / web app"] --> APIGW["API Gateway<br/>HTTP + WebSocket"]
  APIGW --> SeizeAPI["seizeAPI<br/>Trigger: API Gateway request<br/>Does: Express REST API + WebSocket routes"]
  SeizeAPI --> Auth["Auth<br/>wallet signatures, Safe signatures,<br/>JWT, profile proxy roles"]
  Auth --> DomainRoutes["Domain routers<br/>drops, waves, profiles, ratings,<br/>NFTs, TDH, subscriptions, notifications"]
  DomainRoutes --> OpenApi["OpenAPI contract<br/>generated models + manual route wiring"]

  SeizeAPI --> ReadPool["API read pool"]
  ReadPool --> MySQL["MySQL / RDS<br/>source of truth"]
  SeizeAPI --> WritePool["API write pool"]
  WritePool --> MySQL
  SeizeAPI --> Redis["Redis<br/>cache, rate limits, locks, webhook dedupe"]
  SeizeAPI --> ApiSideEffects["SQS producers, S3 upload prep,<br/>webhooks, RPC/proxy calls"]

  BackgroundServices["Scheduled, SQS, SNS, edge,<br/>and manual Lambda services"] --> LambdaRuntime["doInDbContext<br/>load env/secrets, init TypeORM DB,<br/>init Redis, wrap with Sentry"]
  LambdaRuntime --> MySQL
  LambdaRuntime --> Redis
  LambdaRuntime --> Ops["Sentry / CloudWatch / Discord"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  ChainSchedules["EventBridge schedule trigger<br/>chain and NFT jobs"] --> NftsLoop["nftsLoop<br/>Trigger: EventBridge schedule<br/>Does: discover, refresh, audit NFTs"]
  TransactionsLoop["transactionsLoop<br/>Trigger: EventBridge schedule<br/>Does: index contract transfers<br/>Scope: MEMES, Gradients, Meme Lab"]
  NftOwnersLoop["nftOwnersLoop<br/>Trigger: EventBridge schedule<br/>Does: snapshot owner balances"]
  NftHistoryLoop["nftHistoryLoop<br/>Trigger: EventBridge schedule<br/>Does: maintain ownership history"]
  DelegationsLoop["delegationsLoop<br/>Trigger: EventBridge schedule<br/>Does: sync delegation.cash + consolidations"]
  NextgenContractLoop["nextgenContractLoop<br/>Trigger: EventBridge schedule<br/>Does: index NextGen contract events"]
  NextgenMetadataLoop["nextgenMetadataLoop<br/>Trigger: EventBridge schedule<br/>Does: refresh NextGen metadata"]
  ExternalSnapshotLoop["externalCollectionSnapshottingLoop<br/>Trigger: EventBridge schedule<br/>Does: snapshot external collection state"]
  ExternalLiveTailLoop["externalCollectionLiveTailingLoop<br/>Trigger: EventBridge schedule<br/>Does: live-tail external collection transfers"]
  NftsLoop ~~~ TransactionsLoop
  TransactionsLoop ~~~ NftOwnersLoop
  NftOwnersLoop ~~~ NftHistoryLoop
  NftHistoryLoop ~~~ DelegationsLoop
  DelegationsLoop ~~~ NextgenContractLoop
  NextgenContractLoop ~~~ NextgenMetadataLoop
  NextgenMetadataLoop ~~~ ExternalSnapshotLoop
  ExternalSnapshotLoop ~~~ ExternalLiveTailLoop
  ExternalLiveTailLoop --> ChainRuntime["doInDbContext<br/>DB + Redis lifecycle"]
  ChainRuntime --> ChainExternal["MySQL, Redis,<br/>Ethereum / Alchemy / RPC / Etherscan"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  DerivedSchedules["EventBridge schedule trigger<br/>derived state jobs"] --> TransactionsProcessingLoop["transactionsProcessingLoop<br/>Trigger: EventBridge schedule<br/>Does: normalize raw transactions"]
  TdhLoop["tdhLoop<br/>Trigger: EventBridge schedule<br/>Does: calculate TDH + publish completion"]
  TdhHistoryLoop["tdhHistoryLoop<br/>Trigger: EventBridge schedule<br/>Does: write historical TDH snapshots"]
  OwnersBalancesLoop["ownersBalancesLoop<br/>Trigger: EventBridge schedule<br/>Does: project owner balances"]
  AggregatedActivityLoop["aggregatedActivityLoop<br/>Trigger: EventBridge schedule<br/>Does: calculate activity aggregates"]
  MarketStatsLoop["marketStatsLoop<br/>Trigger: EventBridge schedule<br/>Does: aggregate market stats<br/>Scope: MEMES, Lab, Gradients, NextGen"]
  RateEventProcessingLoop["rateEventProcessingLoop<br/>Trigger: EventBridge schedule<br/>Does: process DB-backed rating events"]
  WaveDecisionExecutionLoop["waveDecisionExecutionLoop<br/>Trigger: EventBridge schedule<br/>Does: execute wave decisions"]
  WaveLeaderboardSnapshotterLoop["waveLeaderboardSnapshotterLoop<br/>Trigger: EventBridge schedule<br/>Does: snapshot wave leaderboards"]
  XTdhGrantsReviewerLoop["xTdhGrantsReviewerLoop<br/>Trigger: EventBridge schedule<br/>Does: review xTDH grants"]
  TransactionsProcessingLoop ~~~ TdhLoop
  TdhLoop ~~~ TdhHistoryLoop
  TdhHistoryLoop ~~~ OwnersBalancesLoop
  OwnersBalancesLoop ~~~ AggregatedActivityLoop
  AggregatedActivityLoop ~~~ MarketStatsLoop
  MarketStatsLoop ~~~ RateEventProcessingLoop
  RateEventProcessingLoop ~~~ WaveDecisionExecutionLoop
  WaveDecisionExecutionLoop ~~~ WaveLeaderboardSnapshotterLoop
  WaveLeaderboardSnapshotterLoop ~~~ XTdhGrantsReviewerLoop
  XTdhGrantsReviewerLoop --> DerivedRuntime["doInDbContext<br/>DB + Redis lifecycle"]
  DerivedRuntime --> DerivedStores["MySQL, Redis,<br/>S3 / Arweave snapshots where needed"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  SupportSchedules["EventBridge schedule trigger<br/>support and media jobs"] --> SubscriptionsDaily["subscriptionsDaily<br/>Trigger: EventBridge schedule<br/>Does: process daily subscriptions"]
  SubscriptionsTopUpLoop["subscriptionsTopUpLoop<br/>Trigger: EventBridge schedule<br/>Does: process subscription top-ups"]
  DiscoverEnsLoop["discoverEnsLoop<br/>Trigger: EventBridge schedule<br/>Does: discover ENS names"]
  RefreshEnsLoop["refreshEnsLoop<br/>Trigger: EventBridge schedule<br/>Does: refresh known ENS names"]
  EthPriceLoop["ethPriceLoop<br/>Trigger: EventBridge schedule<br/>Does: snapshot ETH price"]
  MintAnnouncementsLoop["mintAnnouncementsLoop<br/>Trigger: EventBridge schedule<br/>Does: publish mint announcements"]
  ArtCurationNftWatchLoop["artCurationNftWatchLoop<br/>Trigger: EventBridge schedule<br/>Does: watch curated NFT state"]
  RememesLoop["rememesLoop<br/>Trigger: EventBridge schedule<br/>Does: refresh rememes S3, metadata, files"]
  RoyaltiesLoop["royaltiesLoop<br/>Trigger: EventBridge schedule<br/>Does: refresh royalty state"]
  DbDumpsDaily["dbDumpsDaily<br/>Trigger: EventBridge schedule<br/>Does: create daily database dumps"]
  NextgenMediaUploader["nextgenMediaUploader<br/>Trigger: EventBridge schedule<br/>Does: upload NextGen media"]
  NextgenMediaImageResolutions["nextgenMediaImageResolutions<br/>Trigger: EventBridge schedule<br/>Does: generate NextGen image resolutions"]
  SubscriptionsDaily ~~~ SubscriptionsTopUpLoop
  SubscriptionsTopUpLoop ~~~ DiscoverEnsLoop
  DiscoverEnsLoop ~~~ RefreshEnsLoop
  RefreshEnsLoop ~~~ EthPriceLoop
  EthPriceLoop ~~~ MintAnnouncementsLoop
  MintAnnouncementsLoop ~~~ ArtCurationNftWatchLoop
  ArtCurationNftWatchLoop ~~~ RememesLoop
  RememesLoop ~~~ RoyaltiesLoop
  RoyaltiesLoop ~~~ DbDumpsDaily
  DbDumpsDaily ~~~ NextgenMediaUploader
  NextgenMediaUploader ~~~ NextgenMediaImageResolutions
  NextgenMediaImageResolutions --> SupportRuntime["doInDbContext<br/>DB + Redis lifecycle"]
  SupportRuntime --> SupportExternal["MySQL, Redis,<br/>S3, ENS/RPC, Arweave as needed"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  WaveDecisionExecutionLoop["waveDecisionExecutionLoop<br/>Trigger: EventBridge schedule<br/>Does: enqueue claim build for winning drop"] --> ClaimsBuilderQueue["SQS trigger: claims-builder<br/>Payload: drop_id"]
  ClaimsBuilderQueue --> ClaimsBuilder["claimsBuilder<br/>Trigger: SQS claims-builder<br/>Does: build minting claim"]
  ClaimsBuilder --> MintingClaimsTables["MySQL<br/>minting claims + claim actions"]

  MintingClaimsTables -. "separate API request path" .-> SeizeAPI["seizeAPI<br/>Trigger: API Gateway request<br/>Does: enqueue claim media upload"]
  SeizeAPI --> ClaimsMediaQueue["SQS trigger: claims-media-arweave-upload<br/>Payload: contract, claim_id"]
  ClaimsMediaQueue --> ClaimsMediaArweaveUploader["claimsMediaArweaveUploader<br/>Trigger: SQS claims-media-arweave-upload<br/>Does: upload claim media + metadata"]
  ClaimsMediaArweaveUploader --> Arweave["Arweave"]
  Arweave --> MintingClaimsTables
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  NftsLoop["nftsLoop<br/>Trigger: EventBridge schedule<br/>Does: enqueue NFT media work"] --> S3UploaderQueue["SQS trigger: s3-uploader-jobs"]
  S3UploaderQueue --> S3Uploader["s3Uploader<br/>Trigger: SQS s3-uploader-jobs<br/>Does: mirror, compress, upload NFT media"]
  S3Uploader --> S3["S3 buckets"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  SeizeAPI["seizeAPI<br/>Trigger: API Gateway request<br/>Does: enqueue attachment work"] --> AttachOrchestrationQueue["SQS trigger: attachments-orchestration"]
  AttachOrchestrationQueue --> AttachmentsOrchestrator["attachmentsOrchestrator<br/>Trigger: SQS attachments-orchestration<br/>Does: lookup object, retry, enqueue processing"]
  AttachmentsOrchestrator --> AttachProcessingQueue["SQS trigger: attachments-processing"]
  AttachProcessingQueue --> AttachmentsProcessor["attachmentsProcessor<br/>Trigger: SQS attachments-processing<br/>Does: scan/process attachment"]
  AttachmentsProcessor --> MySQL["MySQL / RDS"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  SeizeAPI["seizeAPI<br/>Trigger: API Gateway request<br/>Does: enqueue NFT-link refresh"] --> NftLinkRefreshQueue["SQS trigger: nft-link-refreshes"]
  NftLinkRefreshQueue --> NftLinkRefresherLoop["nftLinkRefresherLoop<br/>Trigger: SQS nft-link-refreshes<br/>Does: resolve external NFT links"]
  NftLinkRefresherLoop --> NftLinkPreviewQueue["SQS trigger: nft-link-media-previews"]
  NftLinkPreviewQueue --> NftLinkMediaPreviewLoop["nftLinkMediaPreviewLoop<br/>Trigger: SQS nft-link-media-previews<br/>Does: generate preview media"]
  NftLinkMediaPreviewLoop --> S3["S3 buckets"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  SeizeAPI["seizeAPI<br/>Trigger: API Gateway/internal request<br/>Does: enqueue push notification"] --> PushQueue["SQS trigger: firebase-push-notifications"]
  PushQueue --> PushNotificationsHandler["pushNotificationsHandler<br/>Trigger: SQS firebase-push-notifications<br/>Does: deliver Firebase push notification"]
  PushNotificationsHandler --> Firebase["Firebase Cloud Messaging"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  TdhLoop["tdhLoop<br/>Trigger: EventBridge schedule<br/>Does: publish TDH completion"] --> TdhDoneTopic["SNS FIFO topic: tdh-calculation-done.fifo"]
  TdhDoneTopic --> XTdhQueue["SQS trigger: xtdh-start.fifo"]
  XTdhQueue --> XTdhLoop["xTdhLoop<br/>Trigger: SNS topic via SQS<br/>Does: recalculate xTDH"]
  XTdhLoop --> MySQL["MySQL / RDS"]
  TdhDoneTopic --> OverRatesQueue["SQS trigger: over-rates-revocation-start.fifo"]
  OverRatesQueue --> OverRatesRevocationLoop["overRatesRevocationLoop<br/>Trigger: SNS topic via SQS<br/>Does: revoke over-rates after TDH changes"]
  OverRatesRevocationLoop --> MySQL
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  S3["S3 buckets"] --> CloudFront["CloudFront"]
  CloudFront --> MediaResizerLoop["mediaResizerLoop<br/>Trigger: CloudFront request<br/>Does: on-demand image resizing"]
  CloudFront --> NextgenMediaProxyInterceptor["nextgenMediaProxyInterceptor<br/>Trigger: Lambda@Edge request<br/>Does: NextGen metadata fallback"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  S3["S3 buckets"] --> DropsVideoCreatedRule["EventBridge trigger<br/>S3 Object Created under drops/"]
  DropsVideoCreatedRule --> DropVideoConversionInvokerLoop["dropVideoConversionInvokerLoop<br/>Trigger: S3 Object Created event<br/>Does: invoke MediaConvert job"]
  DropVideoConversionInvokerLoop --> MediaConvert["AWS MediaConvert"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  S3["S3 buckets"] --> AttachmentObjectCreatedRule["EventBridge trigger<br/>attachment object created"]
  AttachmentObjectCreatedRule --> AttachmentsOrchestrator["attachmentsOrchestrator<br/>Trigger: S3 Object Created event<br/>Does: orchestrate attachment processing"]
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  Operator["Operator / deploy workflow / manual invoke"] --> DbMigrationsLoop["dbMigrationsLoop<br/>Trigger: deploy/manual invoke<br/>Does: TypeORM sync + db-migrate"]
  CustomReplayLoop["customReplayLoop<br/>Trigger: manual invoke<br/>Does: controlled replay job"]
  PopulateHistoricConsolidatedTdh["populateHistoricConsolidatedTdh<br/>Trigger: manual invoke<br/>Does: historic consolidated TDH backfill"]
  TeamLoop["teamLoop<br/>Trigger: manual invoke<br/>Does: team CSV + Arweave upload"]
  DbMigrationsLoop ~~~ CustomReplayLoop
  CustomReplayLoop ~~~ PopulateHistoricConsolidatedTdh
  PopulateHistoricConsolidatedTdh ~~~ TeamLoop
```

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 40, "curve": "basis"}} }%%
flowchart TD
  CloudwatchTopic["SNS trigger: cloudwatch-alarms"]
  CloudwatchTopic --> CloudwatchAlarmsToDiscordLoop["cloudwatchAlarmsToDiscordLoop<br/>Trigger: SNS cloudwatch-alarms<br/>Does: post alarm messages to Discord"]
```

The vertical inventory keeps the rendered width bounded. The specific interaction diagrams below call out the queue and DB handoffs where ordering matters.

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
- Loop mode uses TypeORM initialization and the shared `SqlExecutor` abstraction. Most schema ownership lives in entities, with `dbMigrationsLoop` running TypeORM synchronization and optional `db-migrate` migrations.

The core architectural choice is that MySQL is both the system of record and the internal integration layer. This keeps the system understandable, but it makes table contracts, migrations, backfills, indexes, and worker idempotency especially important.

## Async Processing

There are three async patterns:

- EventBridge scheduled pollers: periodic ingestion, aggregation, refresh, and operational jobs.
- SQS workers: retryable side effects and heavier processing.
- DB-backed event processing: the `events` table stores processable events, and `rateEventProcessingLoop` locks and dispatches them to listener implementations.

Most long-running scheduled jobs have reserved concurrency set low, usually `1`, which protects shared tables from concurrent writer races. SQS workers use queue visibility timeouts, DLQs, and batch failure reporting where configured.

## Claim Queue Flows

The claim flows are representative of how this codebase uses SQS: synchronous code commits the durable state change first, then publishes a small message to a purpose-built queue, and the worker re-reads the full entity from MySQL before doing expensive or external work.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 24, "rankSpacing": 44, "curve": "basis"}} }%%
flowchart TD
  WaveDecision["waveDecisionExecutionLoop<br/>Trigger: EventBridge schedule<br/>Does: execute wave decision"] --> DecisionTx["DB transaction<br/>winner drop + decision rows committed"]
  DecisionTx --> ClaimBuildPublisher["enqueueClaimBuild(drop_id)"]
  ClaimBuildPublisher --> ClaimsBuilderSqs["SQS trigger: claims-builder<br/>batchSize=1<br/>DLQ: claims-builder-dlq"]
  ClaimsBuilderSqs --> ClaimsBuilder["claimsBuilder<br/>Trigger: SQS claims-builder<br/>Does: create missing claim<br/>reservedConcurrency=1"]
  ClaimsBuilder --> MintingClaimsService["mintingClaimsService.createClaimForDropIfMissing(drop_id)"]
  MintingClaimsService --> MintingClaimsTable["MySQL: minting_claims<br/>minting_claim_actions<br/>merkle roots/proofs"]

  MintingClaimsTable -. "admin media upload path" .-> AdminClient["Distribution admin client"]
  AdminClient --> UploadEndpoint["seizeAPI<br/>Trigger: API Gateway request<br/>Does: POST /minting-claims/{contract}/claims/{claim_id}/arweave-upload"]
  UploadEndpoint --> UploadLock["MySQL update<br/>media_uploading=true<br/>only if not already uploading"]
  UploadLock --> MediaPublisher["enqueueClaimMediaArweaveUpload(contract, claim_id)"]
  MediaPublisher --> MediaSqs["SQS trigger: claims-media-arweave-upload<br/>batchSize=1<br/>DLQ: claims-media-arweave-upload-dlq"]
  MediaSqs --> MediaUploader["claimsMediaArweaveUploader<br/>Trigger: SQS claims-media-arweave-upload<br/>Does: upload media + metadata<br/>reservedConcurrency=2"]
  MediaUploader --> FetchClaim["Fetch claim by contract + claim_id"]
  FetchClaim --> ArweaveUpload["Upload image, animation if present,<br/>and generated metadata to Arweave"]
  ArweaveUpload --> UpdateClaim["MySQL update<br/>image_location, animation_location,<br/>metadata_location, media_uploading=false"]
  UpdateClaim --> PriorityAlert["Priority alert on failure path<br/>Sentry / configured alert wave"]
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

1. `dbMigrationsLoop` if entities or DB migrations changed.
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
