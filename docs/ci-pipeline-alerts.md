# CI Pipeline Alerts

The API receives signed GitHub workflow outcomes and posts them as the `ci6529`
profile in the configured staging or production CI wave. Frontend and backend
workflow senders use the configured `CI_PIPELINES_ALERT_URL`; the route is
mounted at `/ci-pipeline-alerts`.

## Receiver Contract

The receiver accepts three alert types:

- `workflow` for the legacy general workflow format;
- `deploy` for concise deploy messages;
- `web_e2e` for WEB deployment validation results.

Requests carry a Unix timestamp and an HMAC-SHA256 signature of the timestamp
and exact raw body. The API allows five minutes of clock skew, validates all
fields before posting, and deduplicates an identical accepted payload in Redis
for 24 hours. Posting is deliberately best effort: the endpoint acknowledges a
valid request even when drop creation fails, so notification availability does
not change the workflow result.

## Message Format

Every heading starts with its environment and ends with its outcome marker:

```text
[🚧 STAGING] overRatesRevocationLoop deploy complete ✅
[🚀 PRODUCTION] WEB deploy failed 🚨
```

Use `WEB` for the frontend web service. Preserve backend Lambda identifiers
exactly, including camelCase, and preserve desktop build names. Do not turn
machine identifiers into title-cased prose. Failed deploy and workflow messages
leave a blank line before `cc @devs6529`.

A successful WEB E2E alert is a single line with no mentions:

```text
[🚧 STAGING] WEB E2E passed ✅ [Run #791 (attempt 2)](https://github.com/owner/repository/actions/runs/791)
```

Attempt 1 has no attempt suffix. A failed WEB E2E alert is detailed and
mentions the mapped manual initiator, the original deploy initiator when
different, and `@devs6529`.

## Deploy Reply Correlation

After creating a successful frontend WEB deploy drop, the service stores:

- its drop ID and first part ID;
- its deployed SHA and mapped GitHub initiator;
- a lookup key for repository, environment, and deploy run ID.

The Redis entries expire after 30 days. A later `web_e2e` request supplies
`parent_deploy_run_id`. The matching repository/environment/run key must
resolve to a valid deploy drop before the API supplies a `reply_to` target.

Missing identities, expired entries, partial writes, Redis failure, malformed
entries, or mismatched deploy-run identities all fail safe to a standalone
post. The API must never guess a reply target. GitHub workflows
therefore pass durable deployment identities, not raw Seize drop IDs.

## Reruns And Mentions

A rerun retains the original workflow inputs and resolves the same deploy
target; `run_attempt > 1` is shown as `(attempt N)`. A fresh manual E2E dispatch
without a parent identity posts standalone.

Successful WEB E2E results never mention anyone. Failed results notify the
manual validation initiator and, when distinct and resolvable, the deploy
initiator, followed by the developers group. Automation actors are not treated
as people to mention.

## Deployment And Rollback

`api` owns alert validation, rendering, Redis correlation, and wave posting.
Deploy the receiver before enabling a sender that requires new fields. When
removing fields, coordinate the workflow/API change so no active sender relies
on the removed contract. Let existing notification-producing runs finish
before retiring their receiver fields.

For rollback, restore compatible sender/receiver versions together; roll back
senders first if an older receiver rejects their payload. Preserve run-based
Redis correlation and the independent `releaseNotesGenerationLoop`, its queue,
and release-note grouping/finalization. Notification transport remains best
effort and does not grant deployment permission.

The frontend workflow-side contract, including default-branch E2E activation,
is documented in that repository's
`ops/docs/developer/ci-wave-deploy-validation-notifications.md`.
