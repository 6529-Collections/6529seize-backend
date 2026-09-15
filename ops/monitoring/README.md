# Independent operational monitoring

This package runs in a dedicated monitoring AWS account. It has its own lockfile,
build, GitHub OIDC deployment identity, Lambda roles, public ingress, queues,
receipt table, archive and webhook secrets. No function uses the application VPC,
MySQL, Redis, root dependencies, Discord bot session or application secret loader.
The preferred monitoring region differs from the production application region.

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
The NFT link refresher, wave score refresher, subscription coverage reconciler
and NFT processing loop throttle alarms require at least one throttle in three
of the last five one-minute periods. The NFT refresher's
SQS event source caps concurrency at the
function's reserved capacity, preventing the poller from overshooting that limit.
Isolated throttles therefore do not generate immediate alarm/recovery pairs;
repeated throttling still alerts. Wave score refresh keeps its single reserved
execution: its two FIFO sources and one-minute fallback can contend for that
capacity even while messages drain normally. Subscription coverage reconciliation
and NFT processing also reserve one execution while running overlapping
one-minute and longer schedules. Their short contention can be retried before
the next scheduled run. The sustained rule delays the first throttle warning
until three breaching minutes occur within the five-minute evaluation window;
it does not measure successful business output or guarantee a detection SLA.
Recovery follows the same rolling window without a separate cooldown.
Invocation-error and OOM alarms remain immediate, as do other services' throttle
alarms, including release-note generation. Direct SNS alarm actions are retained.

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

Every accepted CloudWatch alarm/recovery transition still uses the protected
delivery lane immediately; there is no incident cooldown or delayed recovery.
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
and correlation ID. CloudWatch platform events can also include the bounded
infrastructure diagnostic metadata described above. No exception message, stack,
URL, request body, wallet,
username, model response or moderation evidence is sent to the webhook. The
original diagnostic remains subject to source CloudWatch/Sentry access controls.
Discord mentions are disabled. A fingerprint identifies a group without copying
its raw error message. The Sentry signer secret and Discord URL are plain-string
secrets stored only in monitoring-owned Secrets Manager.

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
Within a five-minute fingerprint window, the first occurrence is sent promptly;
repeats update a durable count. The scheduled summary edits the first confirmed
message when its receipt identifies the same group and webhook destination.
Critical/recovery events bypass grouping and continue sending immediately.
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
