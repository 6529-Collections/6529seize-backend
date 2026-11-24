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
   an uncleared halt, reads team windows and holds, runs the drift tool and
   builds the work list. The job summary shows what ships, in order, and what
   is deferred.
2. **Ship** (only in prod mode; the `production` environment, a GitHub token
   that can dispatch workflows and open the halt issue, and OIDC for a
   read-only health role; it installs no packages): for each service in order
   it
   - stops if `main` moved since planning, leaving the rest to the next train;
   - defers the service, with its dependents, if a hold or a quiet window
     covers it;
   - waits, up to 30 minutes, while any other `deploy.yml` run is active, so it
     never displaces or cancels another developer's deploy;
   - checks the time budget, `main`, the holds and the quiet windows again
     before dispatching, because that wait can carry it into a window (the
     holds and team windows as read when the Ship job started), then records
     the service's new release-note groups and checks the time budget, the
     holds and the quiet windows once more, immediately before dispatching;
   - dispatches `Deploy a service` with `environment=prod`, the service,
     `expected_source_sha` set to the train's commit and `release_note_groups`;
   - waits for the run and checks the new build's health.

Services the plan defers instead of shipping:

| Deferred because | What to do |
| --- | --- |
| `deploy_train.mode` is `manual` in the catalog | Deploy it by hand when ready. |
| No merged PR explains the change, or part of it | Deploy it by hand with release-note metadata. |
| More than 100 PRs, or groups too large for one dispatch | Catch it up by hand once; the train then keeps it current. |
| A temporary hold names it | Finish the hand-run step, then clear the hold. |
| A quiet window is active within 15 minutes | Nothing; a later train ships it. |
| A dependency is held back, could not be assessed or was never deployed | Fix or ship the dependency first. |
| Its PR's release-note group was fixed before the service fell behind | Nothing; the train ships it once that group has published or expired (8 days). For an urgent fix, see the hand-deploy inputs below. |
| Its PR's release-note group is 7 to 8 days old, so the receiver may or may not still hold it | Nothing; the train ships it with a fresh group once the 8 days are up. |

Release notes: each PR becomes one group (`pr-<number>`) that lists every
service behind `main` because of that PR, including services the train holds
back or defers. The group keeps that service set across trains. Before the
first deploy that carries an incomplete group, the train records the set in an
open issue labelled `deploy-train-ledger` (only the train edits it), because
the release-note receiver keeps the first set it sees for a pull request and
rejects a different one. Later trains send the same set while any member is
still behind. The receiver remembers a group for 7 days from when it first
processes a deploy that carries it, which is never before the ledger recorded
it but can be later (the deploy itself, queue retries). So the ledger sends
its set for 7 days; on the eighth day, when the receiver may or may not still
hold it, the group's remaining members wait, because neither the recorded set
nor a new one is safe to send; after that the group is planned afresh. A
manual redrive of failed release-note messages more than a day after their
deploy can still meet a newer group for the same pull request. If the set
cannot be recorded (the ledger cannot be read or saved), that deploy is
deferred to a later train; a deploy that completes its group still ships. If
the last check before dispatch then stops the deploy, the train withdraws
the group it just recorded, so its timer starts with the deploy that first
sends it. After each deploy
the train records which members shipped; if only that save fails, it warns,
and the next plan works the progress out again from what is still behind.
`publish_release_note` is `true` only on the deploy that completes the group,
after every member that was behind has shipped; a held member keeps the note
unpublished until it ships. The train never uses the release-note opt-out.

Deploying a group member by hand: dispatch `Deploy a service` with
`environment=prod`, the service, `expected_source_sha` set to the `main`
commit you reviewed, and `release_note_groups` holding one entry per pull
request whose group lists the service, for example:

```json
[
  {
    "release_group_id": "pr-2601",
    "release_group_services": ["nftsLoop", "teamLoop"],
    "pull_request_number": 2601,
    "publish_release_note": false
  }
]
```

- `release_group_services`: copied exactly from that pull request's entry in
  the ledger issue. With no entry, list every service behind `main` because of
  that pull request (the latest train summary lists them), including this one.
- `publish_release_note`: `true` only if every other service in the set has
  already shipped.

A service missing from an existing group (it fell behind because of that pull
request after its group was fixed) cannot report into that group: the receiver
rejects a service outside the recorded set until the group publishes or
expires. For an urgent fix:

- If the fix is its own merged pull request, which is the usual case, send
  only the groups that list the service: the fix's group, with the services
  behind because of it. Leave the older pull request out; its note keeps its
  own set. The train does the same on its own, so it ships such a service
  without waiting.
- If no newer pull request lists the service, either wait for the older group
  to publish or expire (8 days after the ledger recorded it, when the train
  ships it on its own), or deploy with `release_note_opt_out=true`
  and no other release-note inputs. The opt-out is the deployer's explicit
  choice to publish no note for that deploy; the train never makes it.

Routine migrations stay in the train. It deploys `dbMigrationsLoop` first, with
the default `full` schema scope. Services whose catalog entry depends on
`dbMigrationsLoop` (directly or through another service) deploy only after that
migration deploy succeeded in the same train. `Deploy a service` invokes the
migration synchronously and fails on a function error. If the migration is
deferred, held or fails, its dependents wait.

Urgent fixes keep using `Deploy a service` by hand; the train waits for a
manual run and never cancels it. A release that needs a non-catalog order or
an operator step (a scoped `dbMigrationsLoop` run, a backfill between deploys,
a frontend that must ship first) sets a temporary hold first.

### Quiet windows, team windows and holds

Quiet windows live in the catalog as `deploy_blackouts`:

- `window`: `start` and `end` (`HH:MM`, `end` may be `24:00`, overnight
  allowed), an optional IANA `timezone` (UTC by default) and optional `days` on
  which the window starts;
- `team-freeze`: holds the service during any announced team window.

The train will not start a deploy that a window covers within the next 15
minutes. A window belongs only where a deploy would disrupt a specific
scheduled run or event. A Lambda code or configuration update does not cancel
an invocation that is already running (it finishes on the old code), so an
ordinary scheduled loop needs no window. Current rules:

| Service | Quiet window |
| --- | --- |
| `royaltiesLoop` | 01:55-02:30 UTC (02:01 run) |
| `releaseDigestLoop` | 23:20-24:00 UTC (23:30 run) |
| `claimsBuilder`, `claimsMediaArweaveUploader`, `s3Uploader` | Mint launch Mon/Wed/Fri 17:30-19:45 and close Tue/Thu/Sat 16:50-18:30, Europe/Athens |
| `populateHistoricConsolidatedTdh` | Any team window (team freeze) |

The mint rules cover the launch and close of the regular Mon/Wed/Fri cadence
only, not the whole public mint. Announce extra or moved mint days as team
windows.

Two temporary controls live in the committed file
`ops/deploy-train/controls.json` (reviewed, for planned use) and in repository
variables (immediate, no merge):

- **Team windows** (`windows`, variables `DEPLOY_TRAIN_TEAM_WINDOWS*`): a time
  range, at most 31 days, after which the window expires by itself.
- **Holds** (`holds`, variables `DEPLOY_TRAIN_HOLDS*`): no end time; the train
  leaves the named services and their dependents alone until the hold is
  removed. Use a hold for a release that needs a non-catalog order or an
  operator step. A hold keeps protecting dependents after the held service
  itself is current, for example while a backfill runs after a hand-run
  scoped `dbMigrationsLoop` deploy, and the Ship job checks it against every
  catalog dependency of a service, not only those in the same train.

The train reads every repository variable whose name starts with
`DEPLOY_TRAIN_HOLDS` or `DEPLOY_TRAIN_TEAM_WINDOWS` and merges their entries.
Each entry is tagged with the variable it came from, and that name appears in
the train's deferral reasons. Use one variable per person,
`DEPLOY_TRAIN_HOLDS_<login>` and `DEPLOY_TRAIN_TEAM_WINDOWS_<login>`, so two
developers never overwrite each other's entries. The unsuffixed names still
work for shared entries.

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
  ],
  "holds": [
    {
      "services": ["dbMigrationsLoop"],
      "reason": "Run the pinned-wave-order schema scope by hand first",
      "owner": "github-login"
    }
  ]
}
```

A variable holds the same object, or just the list. To hold before a release
and clear afterwards, in your own variable:

```bash
gh variable set DEPLOY_TRAIN_HOLDS_PRXT6529 -R 6529-Collections/6529seize-backend \
  --body '[{"services":["dbMigrationsLoop","api"],"reason":"scoped migration first","owner":"prxt6529"}]'
# merge, run the operator steps and the hand-run deploys, then:
gh variable delete DEPLOY_TRAIN_HOLDS_PRXT6529 -R 6529-Collections/6529seize-backend
```

Before editing a shared variable such as `DEPLOY_TRAIN_HOLDS`, read it and
keep the other entries:

```bash
gh variable get DEPLOY_TRAIN_HOLDS -R 6529-Collections/6529seize-backend
```

Times are UTC. `"*"` covers every service; named services must exist in the
catalog. A malformed window or hold, or an unknown field, fails the plan, so
nothing deploys until it is fixed. A running train read the variables when it
started; a hold or window set during a train applies from the next one, so
cancel the running train if it must stop at once. Cancelling stops further
dispatches but not a `Deploy a service` run the train already started: find
that run in the Actions tab and let it finish (or cancel it too) before
starting the protected work. A train cancelled after dispatching a deploy
records a halt, because no train checked that deploy's health.

### Health check and halts

`Deploy a service` already verifies the deployed code digest, the CloudFormation
stack or the API's live version. After it succeeds, the train checks every
verification target of the service. All signals start when the **new build
went live**: the function's `LastModified` after the update, not the start of
the deploy run. Log signals come only from log streams created after that
(up to the 500 most recently active, read 100 at a time), and only until the
service's observation window closes. If the deploy left a function
unchanged (its `LastModified` predates the deploy), its existing code running
normally does not verify the deploy: it is reported as not yet verified.
Error metrics are per minute, so they are counted from the start of the
minute the build went live: errors in that minute count against the new
build rather than being missed.
After a code update Lambda serves invocations from new execution environments,
so those streams hold only the new build's output, and traffic still served by
the old build cannot pass or fail the check.

- Halts at once: the Lambda update failed, or the new build logged a startup
  or database-login failure (`Access denied`, `ER_ACCESS_DENIED`,
  `Cannot find module`, `ImportModuleError`, an init `Status: error` or
  `Status: timeout`, or a database login with another mode than `[AUTH IAM]`;
  `DEPLOY_TRAIN_DB_AUTH` overrides `IAM`).
- Halts on generic Lambda errors only when they repeat and clearly exceed the
  normal rate: at least `DEPLOY_TRAIN_ERROR_MIN_COUNT` errors (default 3) since
  the new build went live, and, when the function had errors in the 24 hours
  before, at least `DEPLOY_TRAIN_ERROR_RATE_FACTOR` (default 2) times that
  error rate. These defaults are provisional until there is data from real
  trains; both are repository variables.
- Healthy: the new build handled at least one invocation (a `REPORT` line in
  its own log streams) and, for services that bundle the database modules,
  logged the `[AUTH IAM]` login line.
- **Not yet verified** otherwise: the new build has not been invoked.

After each deploy the train waits up to five minutes for a first healthy or
unhealthy result, then **continues** with the next service. Every deployed
service stays under watch for its whole 30-minute observation window, healthy
or not yet verified. The train re-checks it after each later deploy and once a
minute after the last deploy, until every window has closed. The checks count
errors since the new build went live, so errors crossing the threshold, or a
startup or login failure, anywhere inside the window still halt the train,
even after a first clean invocation. A service the new build never served in
its window is reported as not yet verified in the result and the CI wave post.
Many loops run hourly or daily, so waiting for every one before the next
deploy would stall the train for hours, and the deploy workflow has already
verified the code digest. Dependents of a not-verified service still deploy;
`dbMigrationsLoop` is verified by its synchronous invocation. A train starts no
new deploy after 200 minutes, so its last deploy and watch window fit in the
job's time limit.

Resources-only stacks and the Lambda@Edge interceptor rely on the deploy
workflow's own checks.

A failed deploy, an unhealthy service, a health check that cannot run, or a
crash **halts** the train. The ship job fails, posts a failure to the CI wave
and opens a GitHub issue labelled `deploy-train-halt`. Later trains plan in
report-only mode while any such issue is uncleared, however many runs follow.
Only a `Deploy train` dispatch with `resume=true` clears it: its Resume job
comments on the issue, labels it `deploy-train-resumed` and closes it. A
resume clears only the halts opened before it was dispatched; re-running an
old resume run (a new attempt keeps the original dispatch time) cannot clear
a later halt, which needs a fresh dispatch. Closing the issue by hand does not
resume the train. If the plan cannot read the halt
issues or the deploy history from GitHub, it fails and ships nothing; the next
trigger tries again. If the halt issue itself cannot be opened, later trains
still find the stopped Ship job among the newest 500 train runs: one that
failed or timed out, or one cancelled while a prod `Deploy a service` run was
dispatched (any prod dispatch in that window counts, so a hand deploy during a
cancelled Ship also keeps the train halted). Only a resume run dispatched
after that stop whose Resume job completed successfully clears it; a
cancelled, skipped or failed Resume job does not. Runs are checked one by one
back to 14 hours before that resume, the longest a train can wait and then
run, so a train that stopped after the resume was dispatched stays halted even
when newer runs ended before it. If the deploy history is too long to read, a
cancelled Ship in the unread stretch counts as a halt.

A `Deploy a service` run that fails or is cancelled halts the train unless the
run shows it changed nothing in production: its source guard refused a commit
because `main` moved, or it was cancelled before any deploy step started.
Those cases, like `main` moving between deploys, another deploy running for
more than 30 minutes, or the 200-minute budget, only stop the current train.

Re-running only the Ship job of a train does not deploy: its plan belongs to
an earlier attempt of the run. The job ends successfully with that reason in
its summary and records no halt. Dispatch a new train instead (and resume
first if it halted).

Rollback is manual: revert or fix forward on `main` (the train ships it after
the resume), or dispatch `Deploy a service` for the affected service once
`main` holds a known-good state. See the rollback section below for schema
compatibility.

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
own, and a train cancelled after a dispatch records a halt).

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
      "Action": "lambda:GetFunctionConfiguration",
      "Resource": [
        "arn:aws:lambda:us-east-1:<account-id>:function:*",
        "arn:aws:lambda:eu-west-1:<account-id>:function:*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["logs:DescribeLogStreams", "logs:FilterLogEvents"],
      "Resource": [
        "arn:aws:logs:us-east-1:<account-id>:log-group:/aws/lambda/*",
        "arn:aws:logs:eu-west-1:<account-id>:log-group:/aws/lambda/*"
      ]
    }
  ]
}
```

Optional repository variables for the health check: `DEPLOY_TRAIN_DB_AUTH`
(`IAM` or `PASSWORD`, default `IAM`), `DEPLOY_TRAIN_ERROR_MIN_COUNT` (default
3) and `DEPLOY_TRAIN_ERROR_RATE_FACTOR` (default 2).

Enablement:

1. Set `report` for a few days and compare the per-merge "would ship" posts
   and job summaries with what developers deploy by hand. Catch up anything
   the plan defers for release notes.
2. Create the health role.
3. Run one supervised end-to-end release-note check before leaving `prod` on.
   Pick a merged pull request that put two services behind, A and B. Add a
   hold on B and on every other behind service except A, set `prod`, and
   dispatch the train. Expected: the train ships A only, the ledger issue
   records the pull request's group with both services, and no note
   publishes. Then deploy B by hand with that group copied from the ledger and
   `publish_release_note=true`. Expected: exactly one release note publishes,
   for the pull request, listing A and B. Set `report` again if anything else
   happens.
4. Clear the holds and leave `prod` on.

No service is a permanent exception yet; report mode shows whether the
CloudFront interceptor, `royaltiesLoop` or the subscription loops need one
(`deploy_train.mode: manual`).

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
hours, spread over two trains because one train starts no deploy after 200
minutes and then finishes its 30-minute watch. `main` received 225 merges in
the 30 days to 2026-11-23, a median of five
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
