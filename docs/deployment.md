# Deployment

## IPFS infrastructure

IPFS has a separate explicit-dispatch workflow, `Manage IPFS infrastructure`, and
an [operations/recovery runbook](../ops/ipfs/README.md). Its directly maintained
CloudFormation YAML templates are in `ops/ipfs/cloudformation/`; the controller
submits those files without generating templates. It provisions isolated
candidate servers and persistent storage, builds the pinned Kubo/S3 runtime,
and verifies backup/restore before publication. It is not a Lambda service in
`Deploy a service`. No IPFS deployment runs on merge or push. The existing
production server, data bucket, DNS, and shared media distribution remain unchanged;
production changes are disabled in its checked-in policy.

`Adopt existing IPFS resources` is a separate manual workflow for an import-only
production baseline. It audits the existing bucket, server, exclusively used
security group and entire shared CDN against reviewed native-model fingerprints,
prepares an exact four-resource IMPORT change set, then requires a separate execute
dispatch with its ARN. Ownership, template equality and per-resource drift must
pass. Its dedicated service role permits only configuration reads and ownership tags; adoption
adds termination protection and a deny-all update stack policy. Runtime deployment
stays disabled throughout adoption. Its separate import switch is temporarily
enabled only for the authorized operation and reset after verification.
It shares candidate-management concurrency and creates no separate IPFS environment.

IPFS has one shared deployment target, `prod`; there is no separate IPFS staging
environment or staging release phase. The workflow runs only from `main` through
`ipfs-prod`. Local/CI recovery fixtures create no AWS environment. A future
authorized production rollout must validate an unpublished replacement candidate
before traffic handover. No backend Lambda or frontend redeploy is needed.
Active-host updates are rejected. Adoption records ownership without reinstalling
Kubo or changing traffic; runtime replacement still requires a separately reviewed,
validated writer/traffic handover. The runbook distinguishes imported resources
from referenced network, IAM, DNS and host configuration that remain unmanaged.

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
- When the repository variable `DEPLOY_TRAIN_MODE` is `prod`, merging a backend
  change into `main` is its production deployment: the
  [deploy train](#deploy-train-and-drift-guard) ships every affected service.
  Manual `Deploy a service` dispatches stay available; the train waits for them.

## Deploy train and drift guard

The owner's rule (2026-11-23) is to deploy every backend change when it lands,
with a guard that reports anything missed. Before it, a merge to `main` shipped
only the services someone dispatched; an audit on 2026-11-22 found 54 of 62
production services running builds weeks behind `main` (up to 153 PRs).

### Drift tool

`node scripts/deploy-train/cli.js drift --environment prod --target <ref>`
(system `node`, after `./bin/6529 ci` at the root and in `src/api-serverless`,
with `GH_TOKEN` able to read Actions runs) lists the services whose deployable
artifact differs from what runs in that environment. The deployed commit of a
service is the head commit of its newest successful `Deploy <service> to <env>`
run on `main` (prod) or `1a-staging` (staging). A service is behind when any of
these differ between its deployed commit and the target:

- the esbuild bundle bytes, built in memory from both commits with the
  service's own esbuild flags (or the API's esbuild config) and the same
  installed packages;
- the locked version of any package in the bundle (root or API lockfile);
- the files beside the bundle: the service's `package.json`,
  `package-lock.json`, `serverless.yaml`, CSVs and deploy scripts, files its
  build copies (`migrations/`, `database.json`, OpenAPI files) and
  `serverless-config/<env>`;
- the deploy adapter: the catalog fields that shape the deployment (adapter,
  region, memory) and the `deploy.yml` steps that deploy the service;
- the esbuild and Serverless versions that build and deploy it.

For each behind service it reports why, the pull requests that touched those
inputs since the deployed commit, and how long ago the first of them merged.
Services come out in dependency order (`default_dependencies`,
`dbMigrationsLoop` first, then the oldest drift). Never-deployed services are
listed but not shipped: a first deploy creates infrastructure and stays manual.
A deployed commit newer than the target is reported as ahead and never shipped.

Builds run in parallel and only when needed. Each bundle is cached with the
object IDs of every file it read and the listing of every directory on their
paths. A commit that left those unchanged reuses the bundle without building,
and each deployed commit is built once. A cold production run built 116
bundles in about two minutes on a developer machine; a warm run took 15
seconds. CI restores the cache between runs.

### Drift guard

`Deploy drift guard` runs daily at 06:17 UTC. It runs the drift tool for prod
against `main`, writes the report to the job summary and the `deploy-drift-prod`
artifact, and posts it to the production CI wave through
`scripts/notify-ci-wave.mjs` as a `workflow` alert. A clean day posts a
one-line all-clear; drift posts a failure that lists each behind service and
pings the developers. It holds no AWS credentials. Dispatch it with
`environment=staging` for an ad hoc staging report against `1a-staging`.

### How the train works

`Deploy train` (`.github/workflows/deploy-train.yml`) covers production only.
It starts on every push to `main`, every 30 minutes (:07 and :37) and on
dispatch. One train runs at a time; a newer trigger replaces a waiting one and
every train recomputes what still differs, so merges never queue up trains.

1. **Plan** (no deploy credentials): pins the current `main` commit, checks for
   an uncleared halt, reads team windows, runs the drift tool and builds the
   work list. The job summary shows what ships, in order, and what is deferred.
2. **Ship** (only in prod mode; the `production` environment, a GitHub token
   that can dispatch workflows and OIDC for a read-only health role; it
   installs no packages): for each service in order it
   - stops if `main` moved since planning, leaving the rest to the next train;
   - defers the service if it entered a quiet window, with its dependents;
   - waits, up to 30 minutes, while any other `deploy.yml` run is active, so it
     never displaces or cancels another developer's deploy;
   - dispatches `Deploy a service` with `environment=prod`, the service,
     `expected_source_sha` set to the train's commit and `release_note_groups`;
   - waits for the run and checks the service's health.

Services the plan defers instead of shipping:

| Deferred because | What to do |
| --- | --- |
| `deploy_train.mode` is `manual` in the catalog | Deploy it by hand when ready. |
| No merged PR explains the change | Deploy it by hand with release-note metadata. |
| More than 100 PRs, or groups too large for one dispatch | Catch it up by hand once; the train then keeps it current. |
| A quiet window is active within 15 minutes | Nothing; a later train ships it. |
| A dependency is held back or could not be assessed | Fix or ship the dependency first. |

Release notes: each PR becomes one group (`pr-<number>`) that lists every
service in the train that ships it, and the group publishes on the last of
them. If a train stops early, a later train publishes the remaining groups.
The train never uses the release-note opt-out.

The train deploys `dbMigrationsLoop` with the default `full` schema scope. A
change that needs a hand-run sequence (a scoped `dbMigrationsLoop` run, a
backfill between deploys, or a frontend that must ship first) needs a team
window for the affected services before it merges. Run the sequence by hand,
then end the window.

### Blackouts and team windows

Quiet windows live in the catalog as `deploy_blackouts`. A `window` rule has
`start` and `end` (`HH:MM`, `end` may be `24:00`, overnight allowed), an
optional IANA `timezone` (UTC by default) and optional `days` on which the
window starts. A `team-freeze` rule holds the service during any announced
team window. The train will not start a deploy that a window covers within the
next 15 minutes. Current rules:

| Service | Quiet window |
| --- | --- |
| `royaltiesLoop` | 01:55-02:30 UTC (its 02:01 run) |
| `releaseDigestLoop` | 23:20-24:00 UTC (its 23:30 run) |
| `claimsBuilder`, `claimsMediaArweaveUploader`, `s3Uploader` | Mint launch Mon/Wed/Fri 17:30-19:45 and close Tue/Thu/Sat 16:50-18:30, Europe/Athens |
| `populateHistoricConsolidatedTdh` | Any team window (team freeze) |

The mint rules follow the regular Mon/Wed/Fri cadence. Announce extra or moved
mint days as team windows.

A team announces a temporary window in either of two places:

- the committed file `ops/deploy-train/team-windows.json`, for planned windows
  that should go through review;
- the repository variable `DEPLOY_TRAIN_TEAM_WINDOWS`, which takes effect on
  the next train without a merge.

Both hold the same JSON:

```json
{
  "windows": [
    {
      "start": "2026-12-20T00:00Z",
      "end": "2027-01-03T00:00Z",
      "services": ["*"],
      "reason": "Holiday freeze",
      "owner": "github-login"
    }
  ]
}
```

Times are UTC; a window may last at most 31 days (use the mode switch for
longer stops). `"*"` covers every service; named services must exist in the
catalog. A malformed window fails the plan, so nothing deploys until it is
fixed. Expired windows are ignored and can be removed at leisure.

### Health check and halts

`Deploy a service` already verifies the deployed code digest, the CloudFormation
stack or the API's live version. After it succeeds, the train checks every
verification target of the service in CloudWatch, from the start of its deploy
run:

- unhealthy: a log line with `Access denied`, `ER_ACCESS_DENIED`,
  `Cannot find module` or `ImportModuleError`; a database login logged with
  another mode than `[AUTH IAM]` (`DEPLOY_TRAIN_DB_AUTH` overrides `IAM`); or
  Lambda errors, any when the previous 24 hours had none, otherwise more than
  double the earlier error rate;
- healthy: at least one invocation and, for services that bundle the database
  modules, the `[AUTH IAM]` login line;
- pending otherwise. The train waits up to five minutes, then keeps watching
  the service for 30 minutes while it ships the next ones, and five more
  minutes at the end. Services that never run in that time are reported as
  unverified.

Resources-only stacks and the Lambda@Edge interceptor rely on the deploy
workflow's own checks.

A failed deploy, an unhealthy service, a health check that cannot run, or a
crash **halts** the train: the ship job fails and posts a failure to the CI
wave. Later trains plan in report-only mode until someone fixes the cause and
dispatches `Deploy train` with `resume=true`. Main moving, another deploy
running for more than 30 minutes, a cancelled deploy run, or the 300-minute
budget only stop the current train.

Rollback is manual in this version: revert or fix forward on `main` (the train
ships it after the resume), or dispatch `Deploy a service` for the affected
service once `main` holds a known-good state. See the rollback section below
for schema compatibility.

### Mode switch and enablement

The repository variable `DEPLOY_TRAIN_MODE` controls the train:

| Value | Effect |
| --- | --- |
| unset or `off` | Every train job is skipped. This is the default. |
| `report` | Plans and writes the job summary; posts a "would ship" message once per merge. Deploys nothing. |
| `prod` | Plans and ships. |

A dispatch with `mode=report` runs a dry run at any time and cannot raise the
mode. Changing the variable affects the next train; to stop a running one,
cancel its run (a `Deploy a service` run it already started finishes on its
own).

Prerequisite for `prod`: the `production` environment variable
`DEPLOY_TRAIN_HEALTH_ROLE_ARN`, a read-only role trusted for
`repo:6529-Collections/6529seize-backend:environment:production` through
GitHub OIDC (audience `sts.amazonaws.com`) with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "cloudwatch:GetMetricStatistics", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": "logs:FilterLogEvents",
      "Resource": [
        "arn:aws:logs:us-east-1:<account-id>:log-group:/aws/lambda/*",
        "arn:aws:logs:eu-west-1:<account-id>:log-group:/aws/lambda/*"
      ]
    }
  ]
}
```

Enablement: set `report` for a few days and compare the per-merge "would ship"
posts and job summaries with what developers deploy by hand. Catch up anything
the plan defers for release notes. Create the health role, then set `prod`.

### Staging

The train covers production only and relies on staging before merge.
`1a-staging` is a shared union of unmerged branches that developers stage one
service at a time. An automatic staging train would redeploy other developers'
half-finished union states and compete for `deploy-control-staging`, where a
new dispatch replaces another developer's waiting run. Staging stays manual;
nothing merges into `1a-staging` automatically. The drift guard can report
staging on dispatch.

### Parallelism

`Deploy a service` keeps one deploy per environment
(`concurrency: deploy-control-<env>`), and the train ships one service at a
time. The last 500 production deploys took a median of 150 seconds (p90 233
seconds); with the health gate a service takes about three to five minutes,
so a shared-code change that touches 50 services takes about three to four
hours. `main` received 225 merges in the 30 days to 2026-11-23, a median of five
a day and at most 46. On a typical day the train drains well within the day.
On a busy day each merge restarts it with the oldest drift first, and it drains
overnight. Drift stays within hours instead of weeks, so bounded parallel lanes
are left as a separate, reviewable proposal.

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

### Global TDH history widening

Deploy `dbMigrationsLoop` with the full schema scope before `api`. The width
change rebuilds the two global history tables with MySQL's COPY algorithm and
blocks writes to each table during its copy. The migration limits metadata-lock
waits and retries lock timeouts. If it still fails, inspect the Lambda logs and
retry after the blocking work clears. A retry skips an already widened table.
The migration is one-way because narrowing can lose values above the old limit.

### Pinned wave order

Deploy `dbMigrationsLoop` with `db_schema_scope=pinned-wave-order-schema` to add
the nullable position column. Deploy `api` next, then run
`dbMigrationsLoop` with `db_schema_scope=pinned-wave-order-backfill`. Rerun
the backfill if it reaches its time limit. The job updates only null positions
and takes the same per-profile lock as the API. Release the frontend after the
backfill succeeds. Retain the position column and values during a rollback.

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

When the deploy train halted, read its result summary and the failed
`Deploy a service` run, fix or revert on `main`, then dispatch `Deploy train`
with `resume=true`. The resumed train ships the fix with everything else that
still differs.

See [CI Pipeline Alerts](ci-pipeline-alerts.md) and the [deployment skill](../ops/skills/deploy-6529/SKILL.md).
