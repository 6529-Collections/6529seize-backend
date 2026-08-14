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
- lookup keys for repository, environment, deploy run ID, and optional Release
  Bus train ID.

The Redis entries expire after 30 days. A later `web_e2e` request supplies
`parent_deploy_run_id`, `parent_release_train_id`, or both. Every supplied key
must exist and resolve to the same drop. Only then does the API send a
`reply_to` target to drop creation.

Missing identities, expired entries, partial writes, Redis failure, malformed
entries, or disagreement between deploy-run and train identities all fail safe
to a standalone post. The API must never guess a reply target. GitHub workflows
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

This receiver runs in the backend `api` service. Deploy it before enabling the
frontend workflow sender because an older API rejects the new `web_e2e` fields.
For rollback, remove or revert the frontend sender first and then roll back the
backend `api` implementation.

The frontend workflow-side contract, including default-branch E2E activation,
is documented in that repository's
`ops/docs/developer/ci-wave-deploy-validation-notifications.md`.
