# Isolated operational monitoring rollout and recovery

The [standalone package](../../monitoring/README.md) documents scope, delivery
semantics and finite retention. Its runtime has no application DB/Redis/VPC
dependency. Roll out monitoring before its application producers, and complete
acceptance checks before removing the legacy CloudWatch-to-Discord subscription.

## Bootstrap and identities

Provision `ops/monitoring/bootstrap.json` in the monitoring account with an owner
administrative identity, then enable termination protection. The bootstrap has no
application credentials. GitHub environments `monitoring-staging` and
`monitoring-prod` must permit only the protected `main` branch. OIDC trust binds
the exact repository and environment. This trust does not identify a specific
workflow: maintain protected workflow/code review, or separately configure a
customized OIDC subject if exact workflow binding is required.

Install environment variables:

| Variable                         | Value                                                   |
| -------------------------------- | ------------------------------------------------------- |
| `AWS_MONITORING_ACCOUNT_ID`      | Monitoring account ID                                   |
| `AWS_MONITORING_REGION`          | Monitoring region                                       |
| `AWS_MONITORING_DEPLOY_ROLE_ARN` | Matching bootstrap deployment role output               |
| `AWS_MONITORING_CFN_ROLE_ARN`    | Matching bootstrap CloudFormation execution role output |
| `AWS_MONITORING_ARTIFACT_BUCKET` | Bootstrap artifact bucket output                        |
| `MONITORING_PARAMETERS`          | JSON object of non-secret SAM parameter values below    |

Seed plain-string monitoring-owned Secrets Manager secrets
`6529/monitoring/{env}/discord-webhook`, `sentry-webhook-secret`, and optionally
`external-check-in`. Secret ARNs are configuration; secret values never enter
GitHub variables, CloudFormation parameters, logs or PRs. Reuse an existing
incoming webhook when it is the approved destination. Confirm staging versus
production routing explicitly if the same channel is chosen.

`MONITORING_PARAMETERS` needs `SourceAccountId`, `SourceRegion`,
`WebhookSecretArn`, `SentrySecretArn`, `SentryProjects` (comma-separated project
slugs or numeric IDs), and `ProbeTargets` (JSON string containing objects with
`name`, public HTTPS `url`, expected `status`, and optional `jsonEquals`). Set API
health assertions to `{"db":"ok","redis.healthy":true}` because API health can
return HTTP 200 while dependencies are degraded. Website targets can remain
status-only. At most ten targets and ten scalar property assertions per target
are accepted; JSON bodies are limited to 64 KiB, discarded after checking, and
never included in alerts. Redirects fail; use the final approved public URL.
Optional
`ExternalCheckInSecretArn` activates the external dead-man switch.
`RuntimePermissionsBoundaryArn` and `FallbackKmsKeyArn` must be the matching
environment's bootstrap outputs. The retained, rotating fallback key is managed
by the bootstrap identity; runtime deployment roles cannot change its policy.
Use `StagingFallbackKmsKeyArn` or `ProdFallbackKmsKeyArn` for the respective
environment. Both bootstrap artifact buckets and the runtime archive send access
logs to dedicated private encrypted sinks retained for 90 days. Log sinks do not
log to themselves, avoiding recursive log generation.
Every monitoring Lambda role receives the runtime boundary;
the deployment identity cannot remove or substitute it. Source-account relay
roles use their own narrow publisher policy and do not use a cross-account boundary.
`FallbackTargetTopicArn` enables a transitional SNS forwarder to an existing
confirmed source topic. The source topic policy must allow only the output
`FallbackForwarderRoleArn` to publish. This transitional email path still depends
on the source account. A separately confirmed monitoring SNS subscription or
outside-AWS provider is necessary for independent fallback.
The deploy command reads only the environment's exact runtime boundary policy
and requires an exact unconditional `sns:Publish` grant for the configured target.
An omitted `FallbackTargetTopicArn` disables the monitoring forwarder; it never
retains an unvalidated previous target. Bootstrap permissions must be updated
before enabling a new fallback destination.

## Deploy and connect sources

1. Merge reviewed code and run `Deploy operational monitoring` from `main`, with
   the exact full merged SHA and environment. The workflow verifies ancestry,
   installs/tests/builds only this package, obtains its dedicated OIDC session,
   verifies the monitoring account and artifact-bucket owner, and deploys through
   the separate CloudFormation role. Artifacts use `{environment}/{sha}` prefixes.
2. In each source account/region, deploy `source-bootstrap.json` as
   `seize-monitoring-source-bootstrap` with the authorized source identity and
   enable termination protection. Its retained, encrypted, private, versioned
   bucket is independent of application stacks. Use its `SourceArtifactBucket`
   output as `SOURCE_ARTIFACT_BUCKET`. Deploy generated `source-{env}.json` using the source account's separately
   authorized deployment path, in that environment's catalog region. Set
   `MonitoringEventBusArn` from the monitoring stack output. Set
   `ExistingAlarmTopicArn` to the existing regional confirmed email topic where
   available. Preserve every existing email subscription and existing alarm.
   The guarded `../../bin/6529 run deploy:source` command performs account,
   region, artifact ownership and coverage/subscription preflight before packaging
   and deploying `seize-monitoring-{env}-source`. Run `generate:check` and `check`
   first. It requires `MONITORING_ENVIRONMENT`, `MONITORING_COMMIT_SHA`,
   `SOURCE_ACCOUNT_ID`, `MONITORING_ACCOUNT_ID`, `MONITORING_EVENT_BUS_ARN`,
   `SOURCE_ARTIFACT_BUCKET`, optional `SOURCE_ALARM_TOPIC_ARN`, and optional
   `SOURCE_CLOUDFORMATION_ROLE_ARN`. Set `AWS_CLI_PATH` to the absolute path of the
   operator-approved AWS CLI installation outside the checkout (for example,
   `/usr/local/bin/aws` on the hosted Linux runner). Scripts resolve symlinks and
   reject binaries inside the checkout; they never search npm/repository `PATH`.
   Its AWS session must belong to the source
   account; the monitoring OIDC role cannot deploy this stack. The region is
   derived from the catalog. Cross-region forwarding uses the monitoring bus
   ARN's region, so a production source in `us-east-1` can target `eu-west-1`.
   Leaving `SOURCE_ALARM_TOPIC_ARN` undefined preserves an existing stack's topic;
   explicitly setting it to an empty string disables that optional alarm action.
   Source and monitoring artifact buckets expire current objects after 90 days
   and noncurrent versions after 30 days. Older rollbacks require rebuilding the
   exact commit and uploading a new verified artifact.
3. Preflight the source function/log-group inventory against `coverage-{env}.json`.
   Required log groups must exist. CloudWatch Logs allows a finite number of
   subscription filters per group; inspect existing filters before adding these.
   Missing catalog functions, absent log groups or exhausted subscription quotas
   are rollout blockers, not reasons to silently omit coverage.
4. Enable signed Sentry issue-alert or error-created webhooks on independent
   `/sentry`, with explicit project and environment scope. `production` normalizes
   to `prod`; `staging` stays separate. Unknown/mismatched environments are not
   relabeled. The existing app-owned `/dev-alerts` route is not this ingress.
   Keep frontend Sentry ingestion independent of the application website tunnel;
   confirm browser, SSR and server reporting in the companion frontend change.
5. Configure an outside-AWS endpoint monitor and missed-check-in notification.
   Configure their independent email/on-call destination and verify receipt.
   Merely deploying `/health` does not enroll an external provider.
6. Deploy the affected application producer bundles through their normal release
   process. Shared Logger/Sentry changes affect most backend units; use the
   generated catalog inventory rather than assuming an API-only rollout.

## Acceptance and cutover

Use staging first. All webhook posts and failure injection require the authorized
release operator and an identified test window. Test synthetic metadata only.

- Trigger a handled `Logger.error`, an unhandled/rejected Lambda invocation and a
  resolved API 500. Verify source envelope, EventBridge acceptance, queue receipt,
  confirmed Discord message ID and correct environment/service/correlation.
- Trigger an AWS alarm without relying on successful application execution.
  Verify the protected critical queue and an explicit recovery event.
- Replay the same sanitized event ID and confirm it does not post again; send
  repeated fingerprints and verify first delivery plus the five-minute count.
- Exercise 429, timeout, 5xx and revoked webhook credentials against test fixtures
  or an approved test webhook. Verify retry/DLQ/archive/fallback outcomes.
- Break normal delivery during a controlled test and confirm critical capacity,
  independent health degradation and external missing-check-in notification.
- Confirm Sentry signature rejection, project/environment filtering and redaction
  using a synthetic event. Test frontend reporting while the website is failing.

Only after primary delivery is proven, remove the **Lambda subscription only**
from the old `cloudwatch-alarms` SNS topic. Preserve confirmed email subscriptions.
Do this before enabling the transitional generic fallback SNS forwarder: the old
Lambda expects CloudWatch alarm JSON, so a generic fallback message would make it
fail and potentially produce further operational alerts.

The Discord client and old sender are removed from source and the deployment
catalog after their replacements are integrated. Retire the existing deployed
sender only after confirming that moderation runs through the review database
and both operational lanes deliver successfully. Inspect the old CloudFormation
stack's resources first, preserve its CloudWatch log group and last verified
artifact, and remove only the sender stack and its own SNS subscription and
Lambda permission. Do not remove the shared SNS topic, confirmed email
subscriptions or shared execution role. Re-deploy the monitoring source stack
from the retirement revision so it removes only the obsolete sender's generated
alarms and structured-log subscription. Keep other source coverage unchanged.

The separate `notifier-discord` incoming webhooks for successful business events
remain in place. They do not use a bot session or the removed Discord dependency.
The old application `/dev-alerts` Sentry receiver is a separate integration: do
not retire it until the Sentry provider has been moved to the independent ingress
and that signed delivery has been verified.

## Failure investigation and replay

Start with independent SNS/CloudWatch alarms, `/health`, both queue age metrics,
DLQs, `AdmissionOverflow`, `DeliveryFailures` and the archiver's errors. Search
source diagnostics using the service, correlation/event ID and fingerprint.
Never paste source evidence or secrets into Discord. A missing webhook secret,
permission or revoked credential is a monitoring configuration fault; fix it
without deploying the application.

Rotate a monitoring secret in place; warm instances refresh within one minute.
An archived permanent event has a completed receipt and will not automatically
send again. To replay, an authorized operator must inspect the sanitized record,
reconstruct a valid `kind: alert` work item, assign a **new event ID**, preserve its
environment and permitted severity, and send to the corresponding monitoring
queue. Record the replay reason and original event ID in operator records rather
than adding free-form text to the webhook payload. Hash-only malformed records
cannot be reconstructed and require source-side investigation. Replaying a digest
after receipt retention expires is not supported; replay a reviewed alert instead.

Do not purge queues or delete archive/receipt resources during rollback. They have
retention policies. Roll back the monitoring Lambda artifact or source producer
SHA while keeping queues, secrets and fallback available. Account/region-wide
monitoring failure requires the independently configured external provider; no
component in the failed AWS account can guarantee notification by itself.
