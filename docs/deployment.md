# Deployment

## IPFS infrastructure

IPFS has a separate explicit-dispatch workflow, `Manage IPFS infrastructure`, and
an [operations/recovery runbook](../ops/ipfs/README.md). Its four directly maintained
CloudFormation YAML templates are in `ops/ipfs/cloudformation/`; the controller
submits those files without generating templates. It provisions isolated
candidate servers and persistent storage, builds the pinned Kubo/S3 runtime,
and verifies backup/restore before publication. It is not a Lambda service in
`Deploy a service`. No IPFS deployment runs on merge or push. The existing
production server, data bucket, DNS, and shared media distribution remain outside
this workflow; production changes are disabled in its checked-in policy.

IPFS has one shared deployment target, `prod`; there is no separate IPFS staging
environment or staging release phase. The workflow runs only from `main` through
`ipfs-prod`. Local/CI recovery fixtures create no AWS environment. A future
authorized production rollout must validate an unpublished replacement candidate
before traffic handover. No backend Lambda or frontend redeploy is needed.
Active-host updates are rejected; production adoption requires a separately
reviewed implementation and validated writer/traffic handover.

Agents and developers deploy with ordinary merges and the repository's GitHub
Actions workflows. Use the phase authorized by the user; a staging request does
not authorize production.

Frontend-only, backend-only, and coupled releases use the direct workflows below
without submitting a Coordinator request or waiting for its recording workflow.
Keep existing `.release-coordinator/` run and outbox records as historical evidence.

| Target     | Frontend                                                                       | Backend                                                                                                         |
| ---------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Staging    | Merge into `1a-staging` and push; `Web Deploy - STAGING` starts automatically. | Merge into `1a-staging`, then dispatch `Deploy a service` for each required service with `environment=staging`. |
| Production | Merge into `main`, then dispatch `Web Deploy - PROD`.                          | Merge into `main`, then dispatch `Deploy a service` for each required service with `environment=prod`.          |

Frontend staging retains its existing `ops/**`-only push exclusion. Dispatch
`deploy-staging.yml` on `1a-staging` when an authorized ops-only change needs an
actual deployment.

## Order and completion

- Fetch shared refs before merging; preserve other developers' staging changes
  and resolve conflicts normally. Never force-push a shared branch.
- Read backend `src/config/deploy-services.json` and the change to select the
  required services and dependency order. Dispatch backend services one at a
  time, wait for success, then continue in the same task.
- Deploy backend dependencies before merging/deploying dependent frontend
  changes in each environment. A schema/API change commonly needs
  `dbMigrationsLoop` before `api`, then dependent frontend changes; queues and
  consumers may need their own earlier steps.
- Keep CI, artifact integrity, deployed-version checks, and health checks.
  Successful frontend deployments automatically trigger separate E2E workflows.
  Deployment is complete when build, artifact, live-version, and health checks
  pass. E2E reports separately and does not gate merges, deployments, promotion,
  or release completion. Unrelated PR E2E (for example, Museum tests for a change
  outside Museum) must not delay a release; keep relevant CI checks and report
  the separate E2E status accurately.
- Coordinate potentially conflicting deployments through GitHub run visibility;
  existing concurrency is repository-scoped. Do not cancel another developer's
  run. Wait for that work to finish when the environment would conflict.

## Workflow dispatch examples

Run these only after the corresponding merge and within the authorized scope.
Select the service needed by the change; `api` below is an example.

```bash
gh workflow run deploy.yml -R 6529-Collections/6529seize-backend \
  --ref 1a-staging -f environment=staging -f service=api

gh workflow run build-upload-deploy-prod.yml \
  -R 6529-Collections/6529seize-frontend --ref main
```

Find the new run by workflow, branch, service, and commit; follow that run to
completion. The workflows resolve and verify the source commit and artifact
identity automatically.

Backend dispatches can also supply `expected_source_sha`, the full lowercase
40-character commit SHA reviewed for the release. When supplied, the workflow
rejects a different resolved commit before checkout, builds, or AWS credential
configuration. Release sequencers should always supply this input, because a
branch can move between a caller's check and dispatch. Omitting it preserves
ordinary branch-based dispatch behavior; it does not pin the branch to an
earlier review. Checkout still uses the immutable SHA attached to the run.

Backend production also carries release-note inputs:

- `release_pull_request`: merged PR represented by the deployment;
- `release_group_services`: the complete comma-separated service set, unchanged
  across that PR's sequential deployments;
- `release_note_publish`: `false` until the final service, then `true`;
- `release_note_groups`: per-PR groups when several PRs share the deployment;
- `release_note_opt_out=true`: only when the user explicitly requests that the deployment not
  create a release note, with PR/group metadata omitted and publish left false.

The autonomous bot owns release-note writing and publication. Preserve its
metadata and final signal. CI wave notifications are best effort and use deploy
run IDs to correlate E2E replies.

## Failure and rollback

### Wave score input index

For the author-first Wave Score aggregation, deploy `dbMigrationsLoop` with
`db_schema_scope=wave-score-input-index` before the updated scoring consumers.
This scope adds only `drops(wave_id, author_id, created_at)` as
`idx_drop_wave_author_created`. It requires `ALGORITHM=INPLACE, LOCK=NONE`,
limits metadata-lock waits to two seconds, checks the resulting full-column
visible index, and skips unrelated synchronization, migrations, and maintenance.
If the table is busy or online DDL is unsupported, the deployment fails without
trying a blocking algorithm. Retry after investigating the failure.

The history aggregation uses a MySQL index optimizer hint to select the covering
index when available. MySQL ignores the hint before index installation, so the
old scoring query and the new aggregation both work before and after creation.
Roll back scoring consumers while keeping `dbMigrationsLoop` at an
index-aware revision and retaining the additive index. Full manual schema
synchronization also ensures this index through the same online helper; the
entity marks it `synchronize: false` so TypeORM does not create or drop it itself.

### Retired membership materialisation

The dedicated worker and dispatcher are no longer ordinary deployment choices.
Follow the [combined retirement runbook](membership-retirement.md): verify the
application rollout, back up and inventory resources/data, deploy the updated
`dbMigrationsLoop` with `db_schema_scope=maintenance`, remove monitoring subscriptions, delete dispatcher then
worker, and execute explicit database cleanup last. The removed additive schema
scopes are rejected. Full sync never invokes retirement DDL. The operator CLI
requires an explicit environment; production retirement requires a future authorized phase.
The workflow still defaults to `full`, which synchronizes registered entities and
runs enabled historical migrations; it ignores the unregistered retired tables.
Select `maintenance` explicitly for this rollout to avoid unrelated schema work.

### Operational failures

#### TDH export uploads

`tdhLoop` uploads each wallet and consolidated CSV using `ardrive.net`, then
`turbo-gateway.com` and `arweave.net` on failure. A successful gateway remains
preferred for subsequent chunks. Uploads retain one signed transaction across
failover, use at most eight concurrent chunks, limit each HTTP request to ten
seconds, and stop each export after two minutes. Each request has at most two
attempts per gateway. Permanent validation errors stop immediately. Failure
logs include the transaction, gateway, operation, chunk, attempt, status and a
short provider error code; they exclude keys, CSV bodies and provider stacks.
Unknown HTTP 400 responses also fail over: broadcasters can aggregate temporary
peer rejections under that status without returning a protocol error code.
Those logs summarize peer success/failure counts and statuses. Between complete
chunk retry rounds, allow thirty seconds for fresh headers to propagate; this
backoff is canceled when the same two-minute export deadline expires.

Deploy only `tdhLoop` for upload-only changes; unchanged schema and xTDH
dependencies do not need redeployment. Verify both `/api/uploads` and
`/api/consolidated_uploads` have the target snapshot date/block after invoking
the loop. Also verify both Arweave uploads and their S3 mirrors in the run logs.
New export links use the primary public gateway (`ardrive.net`) so readers do
not depend on `arweave.net` returning complete files after a successful upload.
The immutable Arweave transaction IDs, CSV schema and S3 mirror keys remain
unchanged. Existing links retain their stored gateway URLs.

The synchronous `dbMigrationsLoop` invocation waits up to 960 seconds for its
900-second Lambda and disables AWS CLI retries for that invocation. If its response
is lost, inspect the Lambda invocation logs and completion before retrying the
workflow; a failed CLI response does not prove the migration stopped.

Inspect the failing job and logs. Fix attributable failures on the development
branch, merge the fix into the authorized target, and repeat only the required
deployments. Keep dependent frontend changes waiting for successful backend
dependencies. Report deployment health and E2E as separate outcomes. Investigate
known attributable regressions, but do not wait for E2E or block releases on
unrelated E2E failures.

Use a reviewed revert or compatible known-good source through the same ordinary
workflow for rollback; retain shared history and account for database/API
compatibility. Do not drop schema as part of a routine application rollback.
Report the run links, affected services, health/E2E outcomes, and remaining
failures. Preserve useful logs and artifact evidence without exposing secrets.

See [CI Pipeline Alerts](ci-pipeline-alerts.md) and the [deployment skill](../ops/skills/deploy-6529/SKILL.md).
