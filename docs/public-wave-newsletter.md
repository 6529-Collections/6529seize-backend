# Public-wave newsletter

`newsletterLoop` publishes a short 6529 Mainstream Media edition to a configured
wave using a configured publisher wallet. EventBridge invokes it directly at
00:00 UTC. There is no queue, new database table, API change, or frontend change.

## Configuration

Use the existing `prod/lambdas` Secrets Manager JSON in `us-east-1`:

| Key | Value |
| --- | --- |
| `NEWSLETTER_TARGET_WAVE_ID` | Destination wave UUID |
| `NEWSLETTER_PUBLISHER_WALLET` | Publisher's Ethereum wallet address |
| `NEWSLETTER_PUBLISHER_PRIVATE_KEY` | Matching signing key |
| `NEWSLETTER_BEDROCK_MODEL_ID` | Optional; defaults to `global.openai.gpt-6-astra` |

The publisher must already have a 6529 profile and permission to post in the
destination. The key only signs the normal API login challenge; it is never sent
to Bedrock or the API. Do not put it in code, workflow inputs, or logs.

If any required value is absent or blank, the invocation succeeds with
`not-configured` before connecting to the database or contacting Bedrock/the API.
Complete but invalid configuration fails with a sanitized error. The deployment
environment `NEWSLETTER_STAGE` must be `prod`; other stages return
`not-production` before loading secrets. Shared secrets are cached per warm
Lambda execution environment, as in other loops; recycle environments after
changing configuration when immediate activation/deactivation is required.

## Time windows and retries

Scheduled events cover the complete previous UTC day, start inclusive and end
exclusive. The original EventBridge event timestamp determines the day even if
delivery is delayed. Before generation, a primary-DB query looks for the
publisher's drop in the destination carrying `newsletter_edition_id=daily:DATE`.
`DATE` is the covered day: an October 1 midnight event uses `daily:2026-09-30`.
The normal drop API commits this metadata with the published drop. Reserved
concurrency of one serializes executions; a scheduled retry skips a committed
edition, including when an earlier response was lost. Deleting the published
drop removes that deduplication marker.

The existing API contracts are synchronous: `DropCreationApiService.createDrop`
awaits `executeNativeQueriesInTransaction`, and
`CreateOrUpdateDropUseCase.insertAllDropComponents` awaits `insertDrop` and
`insertDropMetadata` on that same connection. Public identity lookup maps
`IdentitiesDb.getIdentityByWallet().profile_id` to `ApiIdentity.id`;
authentication uses `getProfileIdByWallet`, which uses the same wallet/consolidation
join. The publisher supplies no proxy role, so this is also the stored drop
author. Chat drops accept `signature: null`; participation signature requirements
apply to participatory drops. The destination must allow the publisher to chat.

Manually invoke with `{}`. Every invocation covers the rolling 24 hours ending
at invocation start, uses a fresh edition ID, and bypasses the daily check. A
manual retry is intentionally another edition. Only genuine EventBridge-shaped
scheduled events use the daily path; do not paste such an event when requesting
a manual edition.

## Reporting boundary

Parameterized SQL reads every active anonymously readable wave, including public
subwaves whose parent is public. It excludes DMs, restricted parents/children,
non-visible moderated drops, the destination, and the publisher's own messages.
Reply and quote context uses the same public filters, including older context
needed to link the start of a discussion. Main Stage decisions are selected by
decision time, and indexed Meme and Meme Lab mint transactions by transaction time. Indexing
lag can delay an event's availability; missing transactions are not evidence
that no mint occurred.

Bedrock receives only that public reporting material. The prompt requires linked
handles, linked Meme cards, discussion links with `serialNo`, winner and mint
coverage, and an optional brief final team section. There is one editorial pass
for ordinary volumes. Large days first select stories from every input batch,
then compose one edition; no second fact-check model or private-data tool exists.
Oversized source sets or incomplete model responses fail instead of publishing
truncated coverage. Editorial accuracy and exact link compliance remain model
behavior, not a claim of guaranteed factual correctness.

## Rollout and operations

The service catalog permits **production only**. Code still merges through
`1a-staging` for the normal review/promotion process, without deploying this
Lambda there. After production is authorized, deploy only `newsletterLoop` via
`Deploy a service` on `main`, with `environment=prod`. Then run `Deploy operational
monitoring` for `prod` to update the monitoring allowlist, source log subscription,
and Errors/Throttles alarms. The Lambda must exist first so its log group is
available. No migration or API/frontend deployment is required. Its existing
`lambda-vpc-role` needs Bedrock InvokeModel
access for the selected inference profile and routed foundation models, database
connectivity, and access to the shared secret.

Deploying with any required setting missing leaves publication disabled; the
schedule still invokes a successful no-op daily. Configure all three only when publication is intended. Error reporting
uses the existing Sentry wrapper and CloudWatch Lambda logs; logs contain counts,
model usage, edition/drop IDs, and statuses, not source messages or credentials.
To suspend the schedule immediately, disable its EventBridge rule. Scheduled
errors follow Lambda/EventBridge retry behavior; exhausted failures require an
operator to inspect logs and retry the original scheduled event if appropriate.
