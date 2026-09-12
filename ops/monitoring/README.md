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
Discord notifications remain separate. The old CloudWatch Discord sender remains
available only for a controlled cutover; moderation migration removes its own
legacy callers in a separate change.

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
and correlation ID. No exception message, stack, URL, request body, wallet,
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
repeats update a durable count and schedule a summary. Critical/recovery events
bypass that grouping. The 90-second conditional receipt lease outlives the
30-second dispatcher timeout. A receipt is completed after confirmed delivery,
grouping, or successful permanent-failure archive. `wait=true` and a Discord
message ID are required for confirmed delivery. Timeouts, network errors, 408,
429 and 5xx retry; 429 delays honor vendor backoff. Permanent failures archive
and signal fallback rather than silently succeeding.

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
