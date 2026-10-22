# Independent operational monitoring

This package runs in a dedicated monitoring AWS account. It has its own lockfile,
build, GitHub OIDC deployment identity, Lambda roles, public ingress, queues,
receipt table, archive and webhook secrets. No function uses the application VPC,
MySQL, Redis, root dependencies, Discord bot session or application secret loader.
The preferred monitoring region differs from the production application region.

Retained inert functions are listed in `retained-producers.json`, independently of the
ordinary backend deploy catalog. They keep their existing structured log subscriptions,
producer allowlists, relay permissions and Lambda platform alarms. This inventory never
enables code deployment or removes retained application resources.

The infrastructure source is `scripts/templates.mjs`. `monitoring-{env}.json`,
`source-{env}.json` and `coverage-{env}.json` are generated from the backend service
catalog; CI fails when their inventory is stale. This separate operational package
also reads `platform-functions.json`: observed external/legacy Lambdas receive
Errors/Throttles alarms only. They are not application deploy units, and their
handled errors require their owning service's telemetry integration. The active
`helpBotDailyActivityCreditLoop` is a companion of `helpBotReplyLoop` and belongs
to that service's deploy verification targets and structured-log coverage.

This separate operational package
is deliberately outside the application deployment catalog and release service
bundles. `bootstrap.json` provisions its artifact bucket and deployment identities.
`source-bootstrap.json` provides retained source-account artifact storage so relay
deployments do not depend on another application's deployment bucket.
Build artifacts expire after 90 days, with noncurrent versions retained for 30
days and incomplete multipart uploads aborted after seven days. Rollback using a
previous packaged artifact must stay within that window; older releases require
rebuilding the exact commit and uploading a fresh verified artifact.

## What is collected

| Failure                                     | Path                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Logger.error`, explicit `captureException` | Metadata-only stdout envelope, source Logs subscription, source relay, monitoring EventBridge, normal queue                                         |
| Rejected/thrown/callback Lambda errors      | The same envelope from `wrapLambdaHandler`, with or without configured Sentry                                                                       |
| API and WebSocket resolved 5xx responses    | Handler response hook, unless that invocation already emitted an error                                                                              |
| Crashes, init failures, OOM and timeouts    | `AWS/Lambda Errors` alarms for every catalog function, including functions without the logging wrapper                                              |
| Invocation throttling                       | `AWS/Lambda Throttles` alarms for every catalog function                                                                                            |
| Existing source CloudWatch alarms           | Cross-account EventBridge rule, protected collector and critical queue                                                                              |
| Frontend, SSR or other Sentry errors        | Signed `/sentry` ingress, explicit project allowlist and environment match                                                                          |
| Application endpoint failures               | Monitoring-owned HTTPS probes; two consecutive failures and explicit recovery                                                                       |
| Broken alert pipeline                       | Fresh canaries through both queues, webhook credential health, CloudWatch/SNS fallback, independent `/health` and optional external dead-man switch |

“All errors” means these explicit boundaries, not every arbitrary console string.
Ordinary 4xx responses and moderation decisions are not operational errors. Silent
catches, console-only handled errors outside the shared logger, failures before
telemetry reaches AWS, and unconfigured frontend/external providers remain gaps.
Platform alarms can detect a failed invocation even when JavaScript cannot log it.
Scheduled and queue-driven catalog workers use the shared processing-health policy
below. Their raw Lambda Throttles alarms remain as visibility signals with their
existing periods and thresholds, but direct SNS actions are removed for those
alarms. The collector records transitions instead of immediately posting a red
infrastructure incident. API and external/legacy functions outside that inventory
retain their existing throttle behavior. Lambda Errors, OOM, source-forwarding,
queue-age and dead-letter failure protections remain independent.

Selected raw metrics still use the existing three-of-five or five-of-five
qualification. Those windows describe contention, not successful business output.
The transaction-ingestion composite now includes invocation errors only; its
three child throttle metrics feed the shared contention assessment instead.

Three audited production low-CPU autoscaling controls are recorded without
operator notifications when the collector positively matches their exact source
identity, dimensions, metric, statistic, period and threshold. The policy pins
identity/dimension hashes; it does not match alarm-name prefixes. Matching also
requires the observed AWS low-direction reason grammar and consistent numeric
reason data. Recovery requires a matching previous low ALARM. Unknown, changed,
partial or malformed evidence retains the existing alert path, as do high-CPU,
health, capacity and application failures. This verifies the observed transition
semantics, not every native action setting that is absent from the event. It
does not establish whether the scaling action succeeded: action outcomes are
unobserved by this state-change event. Existing health and failure alerts remain
in place; explicitly failed or unknown metadata does not qualify for this policy.
This applies to the collector's existing ALARM and ALARM-to-OK notification
paths; other OK transitions remain ignored as before.

Successful matches write sanitized evidence under `controls/v1/` in the existing
private archive before acknowledgement and increment `LowCpuControlAudited`.
They do not post to Discord or send fallback email. The object key and body are
stable for a repeated event; retries after ambiguous acceptance can create more
than one S3 version and counter increment. The counter measures successful audit
writes, not unique incidents. Raw reasons, reason data and dimensions are never
archived. Archive failure propagates to existing collector retries and failure
alarms. Native alarms, scaling actions, thresholds and source forwarding remain
unchanged. The current exact policy applies only to production; staging retains
its existing alert behavior and validates the same code with offline fixtures.

Both wave score queues independently alert when their oldest message is at least
1,800 seconds old in three of five one-minute periods. This initial backlog
policy leaves room for the worker's 900-second timeout and 1,000-second message
visibility timeout; it is an operator-tunable guard in `scripts/templates.mjs`,
not a business completion or freshness SLO. The dirty-refresh DLQ alerts on one
visible message in one minute. These alarms use SQS `Maximum` statistics and
treat missing data as non-breaching, so an inactive queue does not page. They do
not detect unqueued database refresh requests or prove that derived scores are
correct. The scheduled fallback remains responsible for missed wakeups.

Unclassified CloudWatch alarm/recovery transitions still use the protected
delivery lane immediately. Enrolled worker throttles use the processing-health
incident lifecycle below.
An alarm that repeatedly crosses its sustained threshold can still notify more
than once. Notifications include bounded alarm identity, metric namespace/name,
statistic, period and numeric datapoint threshold when AWS supplies them. The
datapoint threshold is distinct from the alarm's required number of breaching
periods; a threshold of one on a three-of-five alarm does not mean one spike
immediately pages. Metric-math and
composite alarms omit single-metric labels. Free-form reasons, descriptions,
dimension values and expressions are never copied into that diagnostic metadata.
An application endpoint probe checks status and optional bounded JSON assertions.
Configure API health with `jsonEquals: {"db":"ok","redis.healthy":true}`: its
HTTP 200 alone also covers degraded dependencies. Assertions use exact scalar
equality on at most ten dotted property paths; responses are limited to 64 KiB
and are never logged or retained. Status-only website probes do not prove a
business workflow succeeded. API Gateway/CloudFront failures that prevent Lambda
invocation require their existing platform alarms or external endpoint probes;
the generated per-function alarms alone cannot see them.

The emitter uses `process.stdout.write`, so Lambda TEXT logging does not prepend
console metadata. The relay also handles JSON logging's nested `message` field.

Shared Sentry error capture removes request bodies, cookies, headers, query
strings and user data before transport, including moderation fields submitted on
ordinary content routes. Private `/content-moderation/*` errors additionally
discard evidence-bearing messages, breadcrumbs, extras, context and stack locals;
only bounded type, stack location and trace metadata remain. The final scrub runs
after event enrichment. Existing source logs are still a separate privacy boundary.
Typed `ApiCompliantException` 4xx errors are excluded before enrichment or emission,
including moderation rejection explanations on ordinary profile/group routes.
It never parses arbitrary exception text. AWS account/log-group metadata binds
source identity. The same Error instance is deduplicated within one invocation,
not across future invocations. Local development emits no operational envelope.

The three subscription-processing anomalies use explicit allowlisted condition
codes in their fingerprints; dynamic message text never determines a code.
Existing generic logger calls remain grouped by component and error type.
The three subscription-processing anomalies and duplicate top-up branch use this
pipeline. Their existing business Wave updates stay in place. Successful business
Discord notifications remain separate. The application no longer includes a
Discord client or CloudWatch-to-Discord Lambda deployment unit. Retiring the
previously deployed sender requires the controlled cutover in the runbook;
keep its last verified artifact available until replacement delivery is proven.

Sentry ingress accepts `prod`/`production` and `staging` only. Legacy Lambda
`<function>_prod`/`<function>_staging` Sentry environments are deliberately ignored.
The SDK can initialize before the application's secret loader overwrites its
environment, so secret precedence alone does not prove the SDK uses canonical
names. Redeployed shared producers normalize these aliases independently through
the structured-log path. Verify provider events and canonical environments before
retiring the old Sentry routing; handled errors from other repositories need their
own confirmed provider integration.

## Privacy and delivery contract

The canonical `6529.ops.error.v1` envelope contains bounded service/environment,
event ID, timestamp, severity, fixed error code, fingerprint and optional release
and correlation ID. Application producers can add an allowlisted diagnostic:
fixed failure category, operation, provider, HTTP status, safe resource token,
completed SDK attempts and explicit recovery state from the retry owner. The
collector reconstructs that allowlist; older queued envelopes remain valid and
render red with unknown recovery. Amber requires a validated pending attempt with
attempts remaining. Access denial and validation failures stay red even if another
attempt is pending. The NFT required-page 404 backoff is demand driven and does
not promise a scheduled refresh. CloudWatch platform events can also include the
bounded infrastructure diagnostic metadata described above. No exception message,
stack, URL, request body, wallet, username, model response or moderation evidence
is sent to the webhook. The original diagnostic remains subject to source
CloudWatch/Sentry access controls.
Discord mentions are disabled. A fingerprint identifies a group without copying
its raw error message. The Sentry signer secret and Discord URL are plain-string
secrets stored only in monitoring-owned Secrets Manager.

Roll out the monitoring-account collector and dispatchers before the source-account
LogRelay (`seize-monitoring-{env}-logs`), then redeploy application producers.
The old source relay parses and reconstructs envelopes, so deploying producers
before that relay would discard the new diagnostic. The new parser accepts old
producer and queued event shapes during a phased rollout.

Normal and critical lanes have separate collectors, queues, dead-letter queues,
reserved Lambda capacity and dispatchers. An application envelope is forced into
the normal lane; it cannot select critical severity. The source account's exact
relay/forwarding roles are the only cross-account bus principals. The queue and
receipt services, AWS account limits and downstream Discord rate limits are still
shared dependencies. A dedicated account protects the runtime from application
deployment/DB/VPC failures; it does not protect against AWS Organizations or
management-account administrators, an AWS-wide outage, compromised authorized
monitoring deployment code, or a failure of Discord itself.

Normal events have a per-service admission budget of 120/minute. Excess events
are durably archived before acknowledgement and raise `AdmissionOverflow`.
Normal webhook sends also share a DynamoDB rate slot (one every two seconds per
environment), leaving vendor capacity for critical traffic. Slot contention
defers delivery through SQS; sustained overload can exhaust retries and is archived.
Within the existing five-minute fingerprint window, the first occurrence is sent
promptly;
repeats update a durable count. The scheduled summary edits the first confirmed
message when its receipt identifies the same group and webhook destination.
Safe allowlisted push condition labels distinguish
sender mismatch, provider transients, delivery failure and retry exhaustion.
Critical/recovery events bypass grouping and continue sending immediately.
The push queue has independent source alarms for any visible dead letter and
oldest-message age of at least 30 minutes in three out of five minutes. These
alarms cover handled partial failures that do not increment Lambda Errors. See
[push recovery](../docs/operations/push-delivery-recovery.md).
Confirmed grouping transaction conflicts get up to three
application transaction sends sharing a three-second abort signal for requests
and short jittered waits. Each send retains the SDK's existing retry configuration;
SDK retry sleeps can extend elapsed time beyond three seconds. The atomic receipt/count write and duplicate proof
remain intact. Mixed or unknown failures are not retried locally; exhaustion
still fails the SQS item without acknowledging it. A later queue delivery can
verify a previously committed write before counting again.
The 90-second conditional receipt lease outlives the
30-second dispatcher timeout. A receipt is completed after confirmed delivery,
grouping, or successful permanent-failure archive. `wait=true` and a Discord
message ID are required for confirmed delivery. Timeouts, network errors, 408,
429 and 5xx retry; 429 delays honor vendor backoff. Permanent failures archive
and signal fallback rather than silently succeeding.

Count summaries persist an absolute count and delivery plan before contacting
Discord. An edit retry uses that same count and message, even if a later repeat
increases the group count. `PATCH` must return the exact expected message ID;
timeouts and uncertain responses retry the edit instead of creating a new post.
A completed edit is recorded as `EDITED`, not a new message. The count is a
snapshot, not a guarantee that late arrivals after digest completion are included.

The first message's receipt binds its ID to the webhook identity and secret
version through a nonsecret hash. Missing or legacy acknowledgement metadata
retains the previous summary POST behavior. A specifically confirmed missing
message (`404` / Discord code `10008`) can transition its durable plan to POST;
that fallback remains bound to the original destination. Credential changes,
permission errors, unknown webhooks and ambiguous failures never authorize a
replacement post. Existing permanent-failure archive and fallback signaling
remain active. Missing secret-version metadata does not block first or critical
delivery, but those receipts cannot authorize future edits.

This reduces new count-summary posts, not webhook operations or email traffic.
It still uses the monitoring-owned incoming webhook. Five-minute groups,
initial/protected alerts, source retention and independent fallback are unchanged.

SQS/EventBridge/Lambda delivery is at least once. An ambiguous timeout after
Discord accepted a message can cause a duplicate; this is not an exactly-once
protocol. Normalized event IDs and deterministic summary IDs deduplicate ordinary
retries. Both queues retain for 14 days; exhausted retries move to a 14-day DLQ
and an independent archiver persists sanitized records for 365 days. Its access
logs go to a separate private encrypted bucket with 90-day retention. That sink
does not log to itself, which avoids recursive log generation. The fallback SNS
topic uses a rotating customer-managed key owned by the bootstrap stack. Only
CloudWatch alarms in this environment and the authorized dispatcher/archiver
roles can encrypt fallback publications; runtime roles cannot administer the key.
A backend
exception reported through both Sentry and CloudWatch can form separate groups;
cross-source deduplication is not claimed. Receipts
expire after 45 days. Monitor DLQ/archiver alarms: a prolonged failure of the
archiver can still exceed finite SQS retention. A failed archive write does not
acknowledge the queued item. Source-side Logs delivery and asynchronous Lambda
retries also have finite AWS windows; the source relay DLQ remains in the source
account and may contain the compressed source log batch. Its access is restricted.
Alarm forwarding also uses this same-region DLQ. Event-bus targets reject custom
retry policies; the source template retains the supported DLQ configuration and
alarms when it has visible messages. This alarm uses the optional existing source
SNS topic, whose fallback recipients must be confirmed independently of the
cross-account forwarding path. See the AWS [event-bus target contract](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_events_targets.EventBusProps.html)
and [DLQ permissions and regional requirements](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html).

`/health` returns only `ok` or `degraded`. It requires fresh receipts from both
canary queues and a recent successful authenticated GET of the Discord webhook.
That GET confirms endpoint/credential availability, not a newly posted message.
A live synthetic POST/readback is a deployment acceptance check. The optional
external check-in fires only while both queues are healthy; an external provider
must independently alert on a missing check-in. Its ping URL is another secret.
The monitoring account's probes are outside the application account but inside AWS;
an outside-AWS uptime/dead-man provider is still required for AWS-wide coverage.

## Dispatch diagnostics

Dispatcher logs use a versioned metadata-only schema. `DELIVERY_FAILED` retains
its existing metric and deferral rules: it counts a non-deferred processing
exception, which can occur in storage or scheduling before any webhook request.
The record adds the failing operation, a finite cause code, bounded HTTP/SDK
metadata, lane, work kind, receive count and elapsed time. DynamoDB cancellation
diagnostics retain only bounded allowlisted reason codes, never items or messages.

`sqsMessageHash` is SHA256 of the SQS message ID; `workHash` is SHA256 of the
canonical work ID, matching the suffix of `receipt:<workHash>`. A later
`DELIVERY_SETTLED` record links that attempt to a completed receipt: `DELIVERED`,
`EDITED`, `GROUPED`, `HEARTBEAT`, `NO_REPEAT` or `ARCHIVED`. `ALREADY_COMPLETE` means a
duplicate found an existing completed receipt, not a new webhook delivery.
`INVALID_ARCHIVED` means malformed work was archived and fallback published;
it has no fabricated canonical work hash or completed receipt. Settlement logs
are emitted after the relevant durable operation succeeds.

`deliveryAcceptance` distinguishes `NOT_ATTEMPTED`, `UNKNOWN` and `CONFIRMED`.
Confirmation requires a valid returned webhook message ID; an edit must return
its exact target ID. `DIGEST_PLAN`, `DIGEST_FALLBACK` and `WEBHOOK_EDIT` identify
the new operations, and `DELIVERY_DESTINATION_CHANGED` identifies a failed
destination binding. A failure at `COMPLETE` with confirmed acceptance means the
vendor accepted the POST or PATCH but the receipt write failed. A POST retry can
duplicate the message; an edit retries its saved absolute count. A timeout leaves
acceptance unknown. When releasing a lease or archiving also fails, the record
keeps the original operation/cause and a separate cleanup cause. These fields
do not change the exception, acknowledgement, retry or fallback behavior.

Diagnostics stay in existing monitoring CloudWatch logs under their retention
policy. No exception messages, stacks, response bodies, URLs, credentials,
receipt handles or content are logged. Hashes are not metric dimensions. Logging
failures cannot replace the processing error or prevent acknowledgement. The new
correlation cannot establish outcomes for historical logs that lacked work hashes;
missing terminal logs still require checking the durable receipt and archive.

## Build and verify

From this package directory:

```sh
../../bin/6529 ci
../../bin/6529 run generate
../../bin/6529 run generate:check
../../bin/6529 run check
pipx run --spec cfn-lint==1.40.4 cfn-lint bootstrap.json source-bootstrap.json monitoring-prod.json monitoring-staging.json source-prod.json source-staging.json access-monitoring.json access-source.json dashboard-prod.json dashboard-staging.json
```

The build verifies that every esbuild input stays inside this standalone package.
From the repository root, backend producer tests use the backend dependencies
without starting MySQL:

```sh
./bin/6529 exec jest --config ops/monitoring/scripts/producer-jest.config.cjs --runInBand
./bin/6529 run lint
./bin/6529 run build:ci
```

Root Jest/TypeScript exclude this independent package; the dedicated CI job owns
its tests and compilation. Deployment is described in
[the operational runbook](../docs/operations/isolated-operational-monitoring.md).

## Health dashboards

Separate generated `dashboard-prod.json` and `dashboard-staging.json` templates
show monitoring pipeline health, bounded synthetic probe observations and
verified source-account request metrics. Cross-account console access and role
grants are independent of runtime delivery. Follow the
[dashboard runbook](../docs/operations/monitoring-health-dashboard.md) for metric
semantics, required resource parameters, rollout and validation. Pipeline
heartbeats do not establish application-job success.

## NFT refresh outcomes

`nftLinkRefresherLoop` emits `6529.nft.refresh.v1` EMF records after persistence,
with `Completed`, `Success`, `Failure`, `Unavailable`, `NewUnavailable`, and
`PreviouslyWorkingUnavailable` counts in `6529/NftLinkRefresher`. All six values
(including zeros) share each record. Only `Environment` and the six catalogued
NFT `Provider` values are metric dimensions. Per-link hashes and correlation IDs
stay in source logs. The source-owned `seize-monitoring-{environment}-nft-refresh` dashboard shows
outcomes and newly unavailable counts for each provider; it supplies the persistent-failure review
surface without generating a notification for each link.

Expected canonical-page 404s and recognized recoverable fetch failures do not
send individual notifications. Retry attempts are warnings, counted only when
an outcome is persisted. Unexpected failures, auth errors and unrecognized 404s
still notify; DB/lock exceptions continue through the handler/platform path.
The worker deployment explicitly sets `OPS_ENVIRONMENT`. Missing or invalid
markers emit a configuration error once per warm worker, publish no metrics,
and retain final-failure notifications. Unclassified upstream HTTP failures
remain `unexpected_failure` outcomes and count in provider failure health; only
page-scoped Transient/Manifold 404 evidence qualifies as unavailable.
Only the SQS worker opts into this policy. API callers, retry timings, backoff,
cache preservation and preview/WS failure notifications keep their behavior.

Initial provider policies:

- `FailureRate`: at least 5% failed eligible outcomes, excluding unavailable
  pages from numerator and denominator; at least 20 eligible outcomes per
  five-minute period, breaching three consecutive periods (15 minutes).
- `NewUnavailableSurge`: at least 20 completions in a 15-minute period and either
  five newly unavailable links representing at least 10% of completions, or
  five previously successful links starting a failure episode. A link counts
  once until a successful refresh clears its existing `failed_since` field.
  Links already in a failure episode do not become new incidents on deployment.
- Both alarms require at least 20 outcomes for recovery as well as detection:
  eligible success/failure outcomes for `FailureRate`, or all completions for
  `NewUnavailableSurge`. Each also requires successful samples for recovery.
  A successful window below its 20-outcome gate preserves the prior incident. Missing/ineligible observations leave the prior state
  (`TreatMissingData=ignore`); silence is not recovery. A recovery means the
  aggregate threshold cleared, not that every missing page returned.
- Existing Lambda Errors/OOM/Throttles remain. `NftRefreshAge` alarms at 1,800
  seconds in three of five minutes; `NftRefreshDeadLetters` alarms on one visible
  message. These independently cover a stalled worker.

Before deployment, run the read-only acceptance check from this package:

```sh
AWS_CLI_PATH=/absolute/path/to/aws MONITORING_ENVIRONMENT=staging ../../bin/6529 run verify:nft-refresh-math
```

It evaluates generated expressions with `GetMetricData`/`TIME_SERIES` fixtures
without publishing metrics or notifications. It covers healthy, failed,
low-volume failures and successes, quiet, persistent-unavailable,
new-unavailable, previously-working, and recovery observations. The unavailable-surge expression filters recovery at
its outer boundary: a missing nested `IF` branch can otherwise become zero in
CloudWatch and manufacture recovery without success. Run the matching `prod`
check before production acceptance as well.

Thresholds are operational starting values; low-volume providers may not meet
sample gates. Inspect dashboard counts and retained logs when tuning. Do not
raise thresholds to conceal an unexplained regression. In particular, provider
404 bursts and previously-working pages remain separate signals from persistent
individual missing pages. Raw logs/EMF publication are best effort, and platform
alarms remain independent of the application emitter.

Roll out each environment in this order: refresh the monitoring receiver via
`Deploy operational monitoring` when the target source catalog adds services
since its last deployment; then deploy the generated source stack including the
NFT dashboard (existing `deploy:source` runbook path); finally run `Deploy a
service` for `nftLinkRefresherLoop`. Receiver inventory must precede new source
subscriptions so new service envelopes are accepted. Build/generate from the
merged target branch to preserve staging-only catalog and coverage changes.
The monitoring workflow prints its public health endpoint; verify that health
response and the existing pipeline heartbeat checks before advancing.
Verify all source alarm
expressions/dimensions and queue guards before the worker rollout. Verify EMF
extraction and preserved error coverage from natural traffic or a controlled
staging check. For every provider observed emitting post-rollout outcome records,
require a non-zero CloudWatch `Completed` Sum under the exact environment/provider
dimensions. Compare source-log counters with extracted metric sums; source stdout
alone does not establish extraction. Idle providers stay unverified rather than
healthy. Missing/mismatched metric extraction blocks acceptance and requires
restoring the previous worker before proceeding. Dashboard counts use five-minute
periods; select 15 minutes when reconciling a `NewUnavailableSurge` alarm. No API, frontend or schema deployment is needed.
Rollback the worker first to restore individual reporting; retained counters and
additive source alarms can remain while investigation continues.

## Background processing health

`scripts/loop-policies.mjs` derives the worker inventory from the deploy catalog
and existing Serverless function events. It includes schedules, SQS consumers,
and scheduled rules targeting their queues. Request-serving Lambdas are excluded.
`src/loop-policies.generated.json` is generated for each environment. The shortest
known rate interval is used for multi-mode workers; cron cadence is left unknown
rather than guessed. A rate interval **at most 300 seconds** and reserved
concurrency **exactly one** marks expected overlap. That hint never proves
business progress or authorizes suppression by itself.

`6529.ops.loop-health.v1` contains only finite operation labels, timestamps,
pending status and recovery state. The existing source subscription uses optional
quoted terms to forward either envelope in TEXT or JSON logging, following the
[AWS filter syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html).
AWS log metadata binds the service. The relay reconstructs the allowlist; the
normal collector validates catalog membership and applies a separate
health-only admission budget (120/service/minute, separate from error alerts).
The log relay does not charge admission; the receiver charges once per delivered
event. Noisy health observations cannot consume the error budget. Producers cannot
choose notification severity or the protected lane. No messages, wallets, decision IDs, SQL, user content or exception text are
forwarded. Emission failure cannot fail business work.

The existing monitoring Probe evaluates observations once per minute without
using application DB/VPC/Redis or changing its schedule, timeout or concurrency.
It reads at most five workers concurrently. Missing observations during a throttle
produce amber contention with **catch-up unconfirmed**. Uninstrumented workers
have contention coverage and their existing independent failure guards; they do
not acquire fabricated backlog or business-success coverage. An inactive worker
with no observations is unverified, not positively healthy. Verified idle surveys
can establish that no work is due. A generic handler return never publishes health.

The evaluator distinguishes:

- Bounded overlap with current pending-work/recovery evidence: no incident.
- Old backlog with automatic recovery still available: amber, with the affected
  operation, delay and recovery mechanism.
- Required pending work with no confirmed progress beyond its stall budget,
  unavailable/exhausted recovery, or a threatened deadline: red.
- Stale observations: amber visibility loss; previously observed pending work
  can still exceed its no-progress budget. Missing data cannot clear an incident.

Default delay budget is `max(600 seconds, twice the known rate interval)`.
Default stall budget is `max(function timeout + 300 seconds, three intervals)`;
freshness is `max(timeout + 120 seconds, two intervals)`. Unknown intervals use
60 seconds for these initial operational budgets. These are monitoring policies,
not changes to execution configuration or contractual product SLAs.
The decisions operation uses a 120-second delay/freshness budget and a 300-second
execution-lateness budget, warning red when 60 seconds or less remain. The last
verified survey includes the next future decision, so a hung worker cannot hide
a newly due obligation behind its earlier idle status. Native scans use the normal
stall/freshness allowances (1,200/1,020 seconds for the existing 900-second Lambda),
so a long scan alone cannot trigger the decision lateness alarm. A known due
decision still threatens its deadline even while the native scan runs.
Publication separately allows 600 seconds of delay and 3,900 seconds without progress, accommodating its existing
up-to-one-hour backoff. These initial tolerances are explicit in the generator and
should be calibrated against observed workload and product deadlines before a
production rollout. They can be changed without changing execution settings.

Observations are monotonic with optimistic conditional writes. Late/repeated
observations and alarm transitions cannot overwrite newer state. Multiple raw
alarms for one worker are tracked individually and ORed; one clearing alarm
cannot hide another active alarm. `INSUFFICIENT_DATA` preserves the last known
contention state; a subsequent `OK` clears that alarm even when its immediate
previous state was insufficient data. Missing data alone cannot announce recovery.
The collector retains up to eight recent alarm
identities, reclaiming oldest resolved entries on rename and never evicting an
active alarm. More than eight simultaneous active identities fails closed through
the collector failure guard. A collector-owned
baseline measures time since outstanding work was first observed; it is not a
fabricated business-progress timestamp. A verified advance of the oldest pending
item counts as progress; repeated polls, invocation starts and successful returns
do not reset that clock. Multiple operations are assessed independently so a
moving operation cannot hide a blocked one.

Probe is the sole incident writer under its existing concurrency of one. It saves
an exact pending notification before enqueue, so ambiguous enqueue acceptance
replays the same event ID and existing delivery receipts deduplicate it. Five
concurrent monitoring workers drain the catalog with a shared 20-second I/O budget
inside Probe's unchanged 90-second timeout. An exhausted budget fails the probe
and withholds the external check-in; it cannot report monitoring as healthy.
Changes in severity, cause, operation or recovery state update the incident. A recovery
requires an open incident and fresh evidence that its reported impact cleared.
Active alarms, outstanding obligations and open incidents do not expire under
the receipt TTL; expiry must never manufacture recovery. Resolved state uses the
ordinary retention window. Routine overlap never opens one and never produces
recovery. A contention-only
warning can close when contention ends, explicitly stating that business catch-up
remains unverified; that cannot clear an incident about business processing.

### Initial business observations

- `nftsLoop`: independently tracks `discovery`, `refresh`, `audit` and durable S3
  `publication`. Only committed NFT updates or verified unchanged collections advance
  progress; audit advances after an NFT's S3 checks and necessary queue handoffs.
  In-memory discovery/fetches do not advance progress. Internally handled metadata
  refresh failures stay pending with recovery unconfirmed. Each mode completes only
  after its business pipeline, with its next existing schedule due time retained;
  another mode cannot clear it. The ten-minute/hourly modes have matching freshness
  allowances, while overdue due work still has the normal delay/stall budgets.
  Publication surveys the writer before/after work, including failure: pending
  outbox rows below the publisher's throwing threshold cannot disappear behind a
  successful return. S3 generation itself remains protected by its separate queue
  guards. Initial acceptance requires observing all three natural scheduled modes.
- `nextgenContractLoop`: compares the committed block checkpoint with the actual
  RPC scan target, preserving the scanned block timestamp. Capped ranges stay
  pending while their saved indexing checkpoint advances; they do not complete
  reconciliation. No progress or completion is emitted from inside its transaction;
  rollback and lock-retry attempts cannot establish recovery. Reconciliation is
  independent of indexing: handled metadata/mint-data exceptions and missing
  collection records leave it pending/unconfirmed even if blocks advance. A
  capped scan cannot clear a remembered reconciliation incident. Intentionally
  unrevealed metadata and thumbnails not yet produced by the separate generator
  are not classified as failed indexing work.
- `nftLinkMediaPreviewLoop`: one bounded writer survey after each batch (including
  failure, skipped near the Lambda deadline) uses
  original `media_preview_queued_at` for active PENDING/PROCESSING work and only
  saved READY results for progress. A READY timestamp before the oldest active
  queued work belongs to an earlier episode and is omitted on every survey;
  an idle period cannot make newly queued work immediately appear stalled.
  Lease acquisition, retries, discarded messages,
  stale completion fences and terminal FAILED/SKIPPED results cannot fabricate
  successful preview progress. A DB pending row does not prove SQS delivery/retry,
  so nonempty backlog reports recovery unknown; this adapter does not promise
  silent overlap for every preview throttle. Verified empty active backlog may
  remain idle indefinitely without telemetry warnings, but a stale empty survey
  cannot suppress a new active throttle. Queue age/DLQ/Error/OOM alarms remain
  independent. Saved asset failures retain their application error: draining the
  active queue does not recover those failures. Only errors rejected by an obsolete
  completion fence become informational source logs, since that worker no longer
  owns the result. Ordinary saved failures keep their existing error reporting.
  The preview aggregate has no status index in the declared schema. It is one
  writer survey per batch, with the existing 1-second statement/2-second owned
  read budget, rather than an unbounded query. Before rollout, check its plan and
  latency against live table cardinality; do not increase the budget to force a
  scan through. An unavailable survey must remain unconfirmed. The publication
  outbox already has status-leading indexes, so its pending-only aggregate does
  not require scanning published history.

For these three additional adapters, deploy the isolated monitoring artifact first
(including generated operation policies), then `nftsLoop`, `nextgenContractLoop`
and `nftLinkMediaPreviewLoop`. No source routing/template, API, frontend or schema
change is required. Roll back these three producer artifacts before reverting the
monitoring artifact; new operation labels require the matching receiver inventory.
No execution settings change. A late scheduled start retains the overdue baseline:
starting a run is not business progress or recovery.

- `delegationsLoop`: reads the saved block timestamp best effort, records completed
  persistence/recalculation stages, and reports the actual scanned block timestamp
  only after saving its checkpoint. A scan that took minutes still exposes its
  older watermark. Maintenance completion clears its optional recalculation
  operation, while indexing remains pending until a scheduled scan commits.
  A failed synchronous maintenance action reports recovery unavailable: scheduled
  scans do not replay that explicit action. Backfill mode does not claim ordinary
  indexing recovery. Intermediate phases
  are progress, not proof that the whole non-transactional pipeline is complete.
- `waveDecisionExecutionLoop`: surveys persisted active native scheduled RANK decisions
  (including transferred original-primary competitions) and the durable native
  publication outbox after business processing. Retired wave decision fields and
  legacy execution-effect rows do not establish outstanding work. New diagnostic
  reads have a short owned SQL budget and are skipped near the existing Lambda
  deadline; they never change existing execution settings or run ahead of decisions.
  Their scoped SQL errors stay in source logs without generating application-failure
  incidents; ordinary business DB errors retain their existing reporting. Surveys use
  the writer to avoid replica-lag recovery. Leased and backed-off publication stays
  pending. JSON null native schedules are excluded. Native APPROVE/per-item handled
  failures remain pending even when the worker returns successfully. The native
  engine reports a completed pass only when every discovered item was processed.
  Decision completion and publication are independent operations; this does not
  establish end-to-end claims-builder, push-delivery or announcement success after
  the outbox has handed work to another service. Those retain their own guards.
- `waveScoreRefreshLoop`: independently observes `dirty_refresh` and optional
  `full_refresh`. Bounded writer reads survey outstanding requests and their persisted scores
  before and after processing (including failure); an empty request table establishes
  dirty catch-up. Attempted-wave counts and successful handler returns do not:
  per-wave failures can be handled internally, and re-dirtied versions survive
  processing. Pending age starts at each request's original `created_at` and
  advances only with a persisted `wave_score_calculated_at` or removal of older
  work. Re-dirty timestamps and failed-attempt updates cannot reset the stall
  clock; an already old score does not prematurely age a newly created request.
  The existing one-minute fallback supplies automatic dirty recovery
  even if a wakeup/continuation enqueue fails. Diagnostic failures or reads skipped
  near the existing timeout leave the last observation unchanged, eventually stale.
  Full scans report committed refresh work and remain pending until the scan ends;
  successful continuation handoffs retain the original request time in a message
  attribute, preserving the body and its FIFO deduplication identity. SQS inputs
  can replay after failure; direct full
  invocations report unknown recovery until a continuation is accepted, and
  unavailable recovery if they fail. Dirty runs
  never clear full-scan incidents. Full refreshes not yet started retain their
  independent 30-minute SQS age guard; a completed scan is not proof that every
  queued full request has drained. Both operations use the existing initial
  600-second delay, 1,200-second stall and 1,020-second freshness budgets.
  Verified bounded contention is silent, older pending work warns amber, and
  stalled processing escalates red. The dirty DLQ, queue-age, Errors and OOM
  guards remain independent.

### Rollout and rollback

No deployment is performed by the implementation PR. For each authorized environment:

1. Deploy the isolated monitoring stack/artifact first (collectors, Probe and
   dispatchers), retaining all existing failure alarms. Confirm pipeline health.
2. Deploy the source monitoring stack/LogRelay and generated source alarm routing.
   Confirm both envelope types are accepted and throttles retain their metrics.
3. Deploy `delegationsLoop`, `waveDecisionExecutionLoop` and `transactionsLoop`.
   The last updates only its error composite; it changes no execution settings.
   The shared native execution helper is also bundled by
   `waveLeaderboardSnapshotterLoop`; include that service to refresh its shared
   helper implementation. Then deploy `waveScoreRefreshLoop` for dirty/full refresh
   observations. No API, frontend, schema or migrations deployment is required.
4. From natural traffic or an authorized controlled staging check, verify recent
   observations for indexing, every decision operation and dirty/full score refreshes,
   pending-work detection, routine-overlap silence, amber/red escalation, and
   incident-backed recovery.
   Confirm overdue decision/outbox observations against persisted state before
   claiming business-health acceptance. Missing telemetry remains unverified.
   For score refreshes, compare dirty observations to persisted request rows, verify
   handled per-wave failures stay pending, and verify a dirty success cannot clear
   an unfinished full continuation. Confirm full continuation acceptance and
   original request age, plus preserved SQS/DLQ/Error/OOM routes. Full refresh is
   optional only while idle; a remembered pending full scan still escalates.

Receiver rollout must precede source forwarding and producer changes. Before
changing source routing, reconcile any already-ALARM worker throttle conditions.
Keep their existing notification route until they clear or their active state is
explicitly preserved in the new monitor; transition events alone cannot bootstrap
a pre-existing alarm. Do not claim cutover acceptance with untracked active alarms. Existing
queue/platform alerts remain in place through the transition. Roll back producers
and the transaction composite, restore source throttle SNS actions/subscriptions,
then restore the monitoring artifact if needed. Preserve pending incident/outbox
state so accepted notifications are not lost. Source and monitoring artifacts
remain subject to the existing rollback retention windows.
