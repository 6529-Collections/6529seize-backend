# Membership runtime operations

## Milestones 6–7 controls and activation boundary

The source-producer and scoped-reader integrations are released behind separate
controls. Source tracking defaults to `inactive`; ordinary writes retain their
existing behavior. A staging deployment can opt into `tracking-v1` only after
every relevant writer is on compatible code and an audited source/bootstrap
coverage receipt exists. Tracking is captured before shared secrets load. In
tracking mode, missing source evidence fails the source transaction rather than
creating a zero-version key or claiming readiness. Each committed mutation
coalesces a durable PROFILE, GROUP or FULL target; no SQS send is required for
the invalidation to survive. With processing disabled, repeated invalidations
of one target share a row, while the number of distinct targets can still
grow. Monitor target count, oldest due age and database write overhead before
enabling tracking for sustained traffic.

The worker and dispatcher have an additional staging-only
`staging-controlled-v1` admission mode for the application database. Their SQS
mapping and EventBridge schedule remain independently disabled by default; a
mode change alone does not start background processing or establish source
readiness. The existing isolated fixture mode remains separate. Production
continues to accept only `inactive` for both services. No general bootstrap,
backfill, reader cutover or routine schedule is part of this release.

API materialized reads default to the legacy direct path and shadow comparison
defaults off. Controlled staging reads require an explicit profile allowlist and
are evaluated from one primary snapshot. Missing publication, catalogue/source
evidence, active jobs, changed group rules or expired grant horizons fall back
to direct evaluation. Shadow results count as comparisons only when the same
candidate set and evaluation time are completely evaluated. The normal
production reader remains on the legacy path, regardless of published rows.

Before later production activation, complete the independent deployed-runtime
proof in [#2090](https://github.com/6529-Collections/6529seize-backend/issues/2090),
the audited source/catalogue bootstrap, controlled backlog drain, representative
load and shadow-parity acceptance. The deferred #2090 drill has not passed in
this inactive release.

The runtime packages the fenced worker, external dispatcher and GC. Both
services default to inactive; deployment alone does not provision source
readiness or start background work. The isolated fixture and controlled
application-database modes are staging only and require explicit controls.

## Milestone 8 staging bootstrap and backfill

Milestone 8 establishes source and catalogue evidence and performs an initial
backfill in staging. Ordinary API authorization stays on `legacy` direct SQL;
production tracking, workers, schedules, shadow comparison and materialized
reads stay off. A deployed Lambda, a schema row, or a finished FULL fanout is not
evidence that all profiles have a current publication. Record the exact source
commit, Lambda versions, bootstrap receipt, backfill generation and run IDs,
queue/event correlations, counts and observed results before calling this stage
complete. The procedure below is an activation plan until those live records
exist; it does not claim that staging has already been bootstrapped.

### Preconditions and safe ordering

Complete the reviewed development PR and checks, then record this new
backend-only staging release intent once through the Coordinator CLI before
merging or dispatching any release workflow. Reuse that record for all service
deployments and control changes in this release. Fetch current shared refs,
merge into the latest `1a-staging` without force push, and do not cancel another
developer's deployment. The sequence below starts only after those gates.

Deploy `dbMigrationsLoop` at the reviewed staging SHA and invoke
`db_schema_scope=membership-backfill-probes` before the API, bootstrap carrier,
or any backfill observation. Verify `added_indexes=3`, `verified_indexes=3`,
then repeat the scope and require `added_indexes=0`. It adds only
`idx_mss_scope_updated_target(scope,updated_at_millis,target_id)` and
`idx_mss_scope_active_target(scope,active_jobs,target_id)` on
`membership_source_states`, and
`idx_mrt_scope_updated_target(scope,updated_at_millis,target_id)` on
`membership_refresh_targets`. Each addition uses `ALGORITHM=INPLACE, LOCK=NONE`
with a one-second metadata lock wait. Reconcile an uncertain or partial result
by rerunning the same scope; retain existing indexes and source rows. These
three indexes are required by the final backfill convergence probes.

1. Deploy compatible schema and API receiver code first. Confirm the API's
   deploy-notification catalogue accepts every service in this release; a green
   Lambda deploy alone did not establish that in the prior rollout. Deploy the
   closed `customReplayLoop` operator carrier before invoking bootstrap actions,
   and the worker before its dispatcher. Deploy every eligibility writer and downstream
   receiver at a compatible version while source tracking and both runtime
   triggers remain off. Follow real dependencies, including `xTdhLoop` before
   `tdhLoop` and `delegationsLoop`, and wait for each selected service's artifact,
   runtime and health checks. Deploy the birth-capable `api`, `xTdhLoop`,
   `tdhLoop` and `delegationsLoop` creator paths and drain their older
   invocations before bootstrap `prepare`.
   Do not include unrelated services.
2. Inventory the actual write paths and durable multi-stage source jobs. TDH is
   complete only after xTDH statistics activation and derived levels; delegation
   and consolidation have their own completion barriers. Confirm no older writer
   version can still commit an uncovered mutation. The source/bootstrap receipt
   must name the audited coverage revision and required GLOBAL and PROFILE
   dimensions. Unknown source keys, unfinished jobs and missing writer coverage
   stay unready. Never synthesize completion receipts from existing data rows.
3. Run the versioned, idempotent bootstrap preparation: provision the seven
   GLOBAL keys, then perform a bounded `PRETRACK_PROFILE_SCAN` of existing
   canonical profiles and their six PROFILE source dimensions. Preserve its
   durable cursor, high bound, counts and failures; resume the same operation
   after interruption. This pretracking pass prevents an existing profile's
   first tracked write from encountering a missing key. It is provisional and
   does not certify complete coverage or absence of untracked changes. From
   `prepare` onward, both compatible creator paths must provision a new
   profile's six keys, birth receipt and PROFILE request in their identity
   transaction even while tracking remains inactive. Otherwise a profile born
   between this pass and tracking activation can make a later tracked write fail.
   `prepare` records a 16-minute fence before pretracking can begin. Wait for
   that fence so an older creator transaction with a pre-prepare snapshot has
   ended before its profile can be skipped by the scan. Status reports the
   durable `pretrack_not_before_millis`; an early advance stays at
   `GLOBAL_READY`.
4. Activate `membership_source_tracking_mode=tracking-v1` on all compatible
   staging writers, one service at a time, with the SQS mapping and dispatcher
   rule still disabled. Confirm the effective control and writer version for
   every required unit, drain old invocations, and record the immutable audited
   writer inventory. The current ten deployment units are `api`, `helpBotReplyLoop`,
   `xTdhLoop`, `tdhLoop`, `delegationsLoop`, `overRatesRevocationLoop`,
   `xTdhGrantsReviewerLoop`, `nftOwnersLoop`,
   `externalCollectionSnapshottingLoop` and
   `externalCollectionLiveTailingLoop`. The `helpBotReplyLoop` unit also deploys
   `helpBotDailyActivityCreditLoop`, so the receipt contains eleven Lambda
   function records. Tracked mutations durably bump versions
   and refresh targets in the same transaction.
   If any required writer is untracked, the bootstrap receipt is incomplete and
   materialized readiness cannot be asserted.

   The immutable writer receipt records the expected staging SHA,
   `verified_at_millis`, `old_invocations_drained_at_millis`, and, for each
   function, the full source SHA, Lambda function version, code SHA-256,
   last modification time, timeout, deployment run ID, effective `tracking-v1`
   mode and `staging` stage. Collect these facts from the deployed AWS resources
   and workflow evidence. The API's deployed `GIT_COMMIT` and every other
   writer's deployed `MEMBERSHIP_DEPLOY_SOURCE_SHA` must equal the full staging
   SHA; the human-readable Lambda description alone is insufficient. Shape
   validation in the bootstrap code cannot itself
   verify AWS state or prove that old invocations drained.

5. With tracking active, run bounded `GROUP_SCAN` and
   `POSTTRACK_PROFILE_SCAN` catch-up passes. Catalogue baseline inserts only
   missing group-version evidence; it never overwrites a version committed by a
   concurrent rule, list, visibility, deletion or restoration mutation. Stable
   GLOBAL catalogue/identity version sweeps and source-job checks precede
   `VERIFY` and `COMPLETE`. A profile created during the rollout is covered by
   its birth receipt and the catch-up scan. A new or restored profile beyond a
   FULL fanout bound must retain its own durable PROFILE request. No completed
   receipt may be inferred from a partly populated table.
6. Start one idempotent initial FULL backfill tied to the verified source and
   catalogue receipt. Enable the compatible staging worker mapping first and
   the dispatcher schedule last. The dispatcher recovers due database targets
   through independent EventBridge ticks; the worker consumes SQS and checkpoints
   bounded PROFILE, GROUP and FULL work. Keep worker concurrency, page size,
   statement deadlines and queue pressure within measured staging limits.
   Start in `staging-controlled-v1` to collect independent continuation and
   retry evidence at concurrency two. After that drill, stop the schedule,
   settle in-flight work and measure SQL/queue pressure before switching both
   runtime services to `staging-backfill-v1`. That mode raises the worker cap to
   16, uses pages of at most 128 groups or profiles and permits at most 16
   committed quanta within a 45-second worker budget. The dispatcher examines
   at most 240 raw candidates, with at most 120 per lane, per one-minute tick.
   These are ceilings,
   not throughput guarantees. Increase load only while database latency,
   queue age, worker failure rate and publication progress remain acceptable.
   Stop or slow the schedule if database load, locks, queue age or failure rate
   exceeds the recorded operating budget.
7. Observe the parent FULL fanout separately from its child PROFILE targets.
   `SCAN_CONVERGED` is a point-in-time audit of the parent's captured identity
   high bound, not proof that profiles created or restored later are complete.
   The intended population needs completed publications, including empty
   generations, with source and catalogue freshness checked at publication.
   Inspect due, leased, retrying and parked work; a zero SQS depth can coexist
   with database backlog. Compare controlled representative results against
   authoritative direct SQL without switching ordinary API authorization away
   from `legacy`.

The source and catalogue receipt is a precondition for backfill, not a snapshot
that freezes future writers. Source versions fence stale candidate publication;
later committed changes retain their durable requests. Grant horizons create
future PROFILE requests when a publication has a known time boundary. Verify
those scheduled requests cross naturally during the staging drill, including a
currently false PENDING grant and separate GRANTED/DISABLED source changes.

### Start, status, stop and recovery

The IAM-only `customReplayLoop` carrier accepts exact staging operator actions;
it has no caller-supplied profile, group, database, cursor or page size. Each
advance/observe call performs at most one 64-item page under a 45-second
transaction budget and a five-second statement cap. Invoke one call at a time,
check the CLI result for `FunctionError` and inspect the returned payload,
record its Lambda request ID and progress, and let the measured SQL budget
govern pacing. Do not seed source states, advance cursors, clear
failures or send worker messages by ad hoc SQL. Requery status after an
uncertain response. A repeated backfill start must identify the same generation
rather than enqueue a second FULL request.
If GC or observation reports `ER_LOCK_WAIT_TIMEOUT` while the backfill control
is locked, let the transaction roll back, requery durable status, and retry the
bounded call after the competing transaction finishes; GC records this as
`LOCK_BUSY` for later discovery rather than retiring the protected parent.

| Action                                                          | Stage and effect                                                                                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `membership_bootstrap_prepare_v1`                               | Provision seven GLOBAL keys and create the `membership-bootstrap-v1` control. Call only after compatible creators and old-invocation drain are verified.                                     |
| `membership_bootstrap_advance_v1`                               | Advance one bounded pretracking profile, group, posttracking profile or verification quantum. Reinvoke through `WAITING_FOR_WRITERS`, then again through `COMPLETE` after recording writers. |
| `membership_bootstrap_status_v1`                                | Read the current bootstrap stage, scan bounds/cursors/counts and receipt.                                                                                                                    |
| `membership_bootstrap_record_writers_v1`                        | Record the immutable externally verified ten-unit writer receipt after the pretracking scan and active writer rollout. Its payload also has `tracked_writer_receipt`.                        |
| `membership_backfill_start_v1`                                  | Create or return one initial FULL generation only when bootstrap is `COMPLETE`; the request and checkpoint commit together.                                                                  |
| `membership_backfill_status_v1`                                 | Read stored generation, parent and child-audit progress without advancing the scan.                                                                                                          |
| `membership_backfill_observe_v1`                                | Inspect one bounded child-publication page after parent fanout; repeat until a measured convergence or recorded incomplete state.                                                            |
| `membership_backfill_pause_v1`, `membership_backfill_resume_v1` | Change the audit control's intent; they do **not** stop the AWS schedule, queue mapping or active worker invocations.                                                                        |

Use the returned JSON as the durable control receipt. For example:

```bash
aws lambda invoke --region eu-west-1 --function-name customReplayLoop \
  --cli-binary-format raw-in-base64-out \
  --payload '{"operator_action":"membership_bootstrap_prepare_v1"}' \
  /tmp/membership-m8-prepare-result.json
aws lambda invoke --region eu-west-1 --function-name customReplayLoop \
  --cli-binary-format raw-in-base64-out \
  --payload '{"operator_action":"membership_bootstrap_advance_v1"}' \
  /tmp/membership-m8-advance-result.json
aws lambda invoke --region eu-west-1 --function-name customReplayLoop \
  --cli-binary-format raw-in-base64-out \
  --payload '{"operator_action":"membership_bootstrap_status_v1"}' \
  /tmp/membership-m8-status-result.json
```

For the writer receipt, create a task-local JSON map from the ten deployment
unit names above to their successful staging GitHub Actions run IDs. After all
eleven AWS functions are active and the old invocation window has passed,
generate the exact carrier payload from the reviewed staging checkout:

```bash
GH_TOKEN="$(gh auth token)" ./bin/6529 run --silent membership:m8:writer-receipt -- \
  --expected-sha "$membership_m8_sha" \
  --deploy-runs "$membership_writer_deploy_runs_file" \
  > "$membership_writer_receipt_file"
aws lambda invoke --region eu-west-1 --function-name customReplayLoop \
  --cli-binary-format raw-in-base64-out \
  --payload "fileb://$membership_writer_receipt_file" \
  /tmp/membership-m8-writer-result.json
```

Both file variables must be absolute task-local paths. Preserve the AWS and
workflow evidence with the output; recheck drift after later deployments. The
collector validates the deployed full source SHA, descriptions, modes and
versions, GitHub run source, and an old-invocation drain window at least one
Lambda timeout plus one minute past the latest modification. It emits
`verified_at_millis` and
`old_invocations_drained_at_millis` at the same final collection time, after
that window. Its JSON is a point-in-time receipt, not
continuous AWS monitoring.
The posttracking profile sweep needs a stable GLOBAL IDENTITY version for all
pages. The scheduled staging delegation cycle normally changes that version
before a full sweep can finish. After the tracked delegation release is
verified, disable its staging EventBridge rule, wait for the current cycle and
downstream xTDH work to complete, then advance the bounded bootstrap scan to
`COMPLETE`. Record the rule state before and after. Re-enable the same rule
immediately after `COMPLETE` and verify that its persisted block marker lets
it catch up. Keep the API and all source tracking active throughout; an active
or changed source version still requires a status check and safe retry.
After `COMPLETE`, use the same invocation shape with the backfill actions in the
table. Bootstrap status and backfill status are distinct; inspect both, the
source jobs, database backlog, CloudWatch metrics and actual AWS trigger state.

The existing deployment switches are exact workflow inputs. Each service
deployment resets any omitted membership switch to its safe default, so supply
the intended value on every selected deployment and verify the resulting Lambda
configuration. The commands below are templates for an authorized staging
release after its reviewed code is on `1a-staging`; dispatch one service at a
time and wait for its workflow, artifact, version and health checks before the
next. Set `membership_m8_sha` to the verified full staging SHA, and choose the
single required service for each invocation.

```bash
# Compatible runtime, not processing yet.
gh workflow run deploy.yml -R 6529-Collections/6529seize-backend \
  --ref 1a-staging -f environment=staging -f service=membershipRefreshLoop \
  -f expected_source_sha="$membership_m8_sha" \
  -f membership_runtime_mode=staging-controlled-v1 \
  -f membership_worker_mapping_enabled=false
gh workflow run deploy.yml -R 6529-Collections/6529seize-backend \
  --ref 1a-staging -f environment=staging -f service=membershipRefreshDispatcherLoop \
  -f expected_source_sha="$membership_m8_sha" \
  -f membership_runtime_mode=staging-controlled-v1 \
  -f membership_dispatch_schedule_enabled=false

# After the final audited bootstrap receipt: enable consumer before schedule.
gh workflow run deploy.yml -R 6529-Collections/6529seize-backend \
  --ref 1a-staging -f environment=staging -f service=membershipRefreshLoop \
  -f expected_source_sha="$membership_m8_sha" \
  -f membership_runtime_mode=staging-controlled-v1 \
  -f membership_worker_mapping_enabled=true
gh workflow run deploy.yml -R 6529-Collections/6529seize-backend \
  --ref 1a-staging -f environment=staging -f service=membershipRefreshDispatcherLoop \
  -f expected_source_sha="$membership_m8_sha" \
  -f membership_runtime_mode=staging-controlled-v1 \
  -f membership_dispatch_schedule_enabled=true
```

For a sustained initial drain, halt in the order below, then redeploy the
worker with `membership_runtime_mode=staging-backfill-v1` and its mapping
enabled. Wait for its artifact/runtime check and verify 16/16 reserved/mapping
concurrency. Redeploy the dispatcher with that mode and its schedule enabled
last. Its reserved concurrency stays one. If a rate or database budget is
exceeded, disable the dispatcher schedule first and then the worker mapping;
do not change target counters or publication rows to accelerate the display.

Verify the actual triggers and queue without reading secrets:

```bash
aws lambda list-event-source-mappings --region eu-west-1 \
  --event-source-arn arn:aws:sqs:eu-west-1:987989283142:membership-refresh-work-staging-v1 \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,BatchSize:BatchSize,MaximumConcurrency:ScalingConfig.MaximumConcurrency}'
aws events describe-rule --region eu-west-1 \
  --name membership-refresh-dispatch-staging-v1 \
  --query '{State:State,ScheduleExpression:ScheduleExpression,Arn:Arn}'
aws sqs get-queue-attributes --region eu-west-1 \
  --queue-url https://sqs.eu-west-1.amazonaws.com/987989283142/membership-refresh-work-staging-v1 \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesDelayed ApproximateNumberOfMessagesNotVisible
```

For a controlled pause, disable the dispatcher schedule first, allow current
worker invocations to settle, then disable the worker mapping if a full stop is
needed. Record SQS visible/delayed/in-flight and DLQ counts, database targets
and leases, and effective Lambda controls. Source tracking may remain on during
a processing pause: committed requests continue to accumulate and require
backlog monitoring. Resume with the same generation and durable cursors after
correcting the cause, enable mapping before schedule, and verify the independent
dispatcher recovers expired reservations and leases. Redrive an actual DLQ
message only after preserving its failure evidence and correcting its cause;
use bounded redrive and verify its requested-version fence. Do not delete or
rewrite checkpoints to make a status display green.

Stop by redeploying `membershipRefreshDispatcherLoop` with
the currently selected `membership_runtime_mode` and
`membership_dispatch_schedule_enabled=false`, waiting for the run and the
disabled rule before touching the worker. If a full stop is required, redeploy
`membershipRefreshLoop` with that same mode and
`membership_worker_mapping_enabled=false`, then verify the disabled mapping.
These are ordinary staging workflow deployments at the reviewed SHA, not direct
changes to a CloudFormation-owned rule or mapping. Resume with the enable
sequence above after inspecting durable status and queue age.

If a writer must revert to untracked operation, treat the existing coverage
receipt as invalid for materialized readiness. Keep direct reads, stop background
load as needed, redeploy compatible writers, repeat the source/catalogue audit
and reconcile the gap before any subsequent backfill/read activation. Rollback
retains additive schema, publication history and target requests. Use reviewed
reverts and ordinary deployment workflows; never drop membership tables or
force-push shared branches as routine recovery.

Any later writer code or mode change also requires a fresh coverage assessment.
The stored receipt describes a particular deployed fleet; it does not monitor
AWS configuration after recording. Do not infer continuing coverage from a
matching revision string alone.

### Live staging acceptance and remaining gates

The controlled application-database mode is the smallest available staging
path when it can preserve other users' data and independently prove the
[#2090](https://github.com/6529-Collections/6529seize-backend/issues/2090)
cases. Use task-owned profiles/groups or naturally scoped application data; do
not erase shared source state for a drill. Correlate more than 16 distinct
EventBridge/dispatcher/SQS/worker invocations on one generation, natural
retry/DLQ/redrive, a failed send after committed reservation and natural expiry,
interrupted FULL and DIRTY work including a large group, partial-run source
supersession, time/grant and identity changes, fanout bounds, lease reclaim,
reader overlap/GC, and safe shutdown. Record which items actually
pass; keep #2090, #2071 or #2072 open for any missing live criteria. Small
fixtures and synthetic logs do not prove this deployed behavior. #2074's
representative capacity and API p95/p99 cutover gates remain separate.

After the bounded drill, leave normal API reads in `legacy` and the worker
mapping and dispatcher rule in an explicitly verified safe staging state. A
fresh related staging E2E run must pass before milestone 8 Phase 3 is complete.
For a backend-only release, dispatch the frontend `staging-e2e.yml` workflow on
`main` with `automatic_deploy_run_id` set to the successful **currently live**
`Web Deploy - STAGING` run ID. Its workflow binds the test source to that exact
frontend deployment; record the backend staging commit and service runs
separately. The dispatch is:

```bash
gh workflow run staging-e2e.yml -R 6529-Collections/6529seize-frontend \
  --ref main -f automatic_deploy_run_id="$membership_live_web_deploy_run_id"
```

Run the relevant full packs after the controlled backend work and
wait for a green result. Do not reuse an older E2E result as proof of this
activation.
The handoff must separate implemented controls, actual live evidence and
unpassed production activation prerequisites. No production merge, deployment
or activation follows from this staging result.

## Historical M2–M5 runtime deployment

The schema, fixture carrier and independent monitoring below were deployed in
the completed inactive M2–M5 release. They are not additional deployment units
for M6–M7 unless verification finds a missing prerequisite. M6–M7 deploys the
API, worker, dispatcher and affected producer services in dependency order.

1. Deploy `dbMigrationsLoop` at the reviewed source and invoke
   `db_schema_scope=membership-evaluator-index` if that prerequisite is not already
   applied. Verify the exact visible candidate index and idempotent result.
2. Deploy/invoke `dbMigrationsLoop` with `db_schema_scope=membership-runtime-control`.
   Verify `created_tables` is zero or one, `added_indexes` is zero or one,
   `verified_tables=2`, and `verified_indexes=1`. Repeat once to verify both
   addition counts are zero. This scope requires the existing run table; it never
   replaces the original seven-table scope or performs unrelated maintenance.
3. Deploy `membershipRefreshLoop` with default controls. Verify build/artifact hash,
   exact runtime version and closed status, dedicated IAM role, queue attributes,
   disabled mapping and alarms.
4. Deploy `membershipRefreshDispatcherLoop` inactive with its schedule disabled.
   Verify its one-way worker queue imports, dedicated send-only role, rule,
   invocation permission, asynchronous failure destination and alarms.
5. Deploy `customReplayLoop` containing the closed fixture actions. It has no
   schedule. Production rejects those actions before loading secrets or MySQL.

For M5, redeploy the worker before the dispatcher because its fixture receipt
protocol is part of the transport drill. No frontend code deployment is required
by these inactive backend increments; the combined release still requires fresh
related staging E2E against the actual deployed frontend.

The run index uses `ALGORITHM=INPLACE, LOCK=NONE`, a one-second metadata lock wait
and 120-second DDL client deadline. Inspect the complete plan before either
addition. If the table succeeds but the index fails, keep the table and rerun this
scope after resolving the cause. A client timeout does not establish rollback;
inspect actual schema through the same idempotent scope. Never drop/rebuild data
as retry cleanup. Manual full synchronization cannot bypass these additions.

## Historical independent operational monitoring

The worker and dispatcher stacks install their own alarms. Central
structured-error monitoring is a separate deployment: the generated monitoring
templates admit `membershipRefreshLoop` and `membershipRefreshDispatcherLoop` in
both collectors. The source templates include each function's `/aws/lambda/`
subscription, relay allowlist entry and Lambda Errors/Throttles alarms. These
platform alarms treat missing data as non-breaching while inactive. The enabled
dispatcher heartbeat remains service-owned. The central source alarms coexist
under distinct names; this change does not replace existing alarms or their
delivery topics.

The M2–M5 release completed the separate central monitoring rollout for staging
and production. Its deployment procedure is retained below for future changes;
M6–M7 does not alter `ops/monitoring` and does not request another monitoring
deployment.

For a future monitoring change, complete the following sequence for staging and
then production after its reviewed source is on `main`. Keep production runtime
controls inactive. Record `operational_deployments: ["monitoring"]` only when
that release actually changes `ops/monitoring`.

1. Complete the environment's schema and dependent inactive service deployments
   in dependency order. Verify every function and log group in the exact merged
   `ops/monitoring/coverage-{environment}.json` exists, including both membership
   runtime services. Existing staging deployments may already satisfy this
   prerequisite.
2. Dispatch `Deploy operational monitoring` from `main` with the exact reviewed
   full merged SHA and environment, and wait for success. This updates the
   dedicated monitoring account's `seize-monitoring-{environment}` stack and
   collector allowlists; it does not update application-account subscriptions.
3. From a checkout of that same SHA, run the guarded source deployment with the
   separately authorized application-account identity. It updates
   `seize-monitoring-{environment}-source` in `eu-west-1` for staging or
   `us-east-1` for production. Reuse the existing source bootstrap/artifact bucket
   and monitoring bus output; no bootstrap, dashboard or access-policy deployment
   is required by this catalog addition.
4. Verify both subscriptions, relay and collector allowlists, all four membership
   platform alarms, successful source-stack update and termination protection.
   Prove sanitized delivery with the authorized monitoring acceptance procedure
   before recording central coverage complete. Missing catalog log groups or
   exhausted subscription capacity are blockers. Preserve existing subscriptions
   and allow CloudFormation rollback to finish before retrying.

The coordinator runs these commands once per environment, sequentially, with
`membership_monitoring_sha` set to the reviewed full merged SHA:

```bash
gh workflow run deploy-operational-monitoring.yml \
  --repo 6529-Collections/6529seize-backend --ref main \
  -f environment="$membership_monitoring_environment" \
  -f commit_sha="$membership_monitoring_sha"

# After the workflow succeeds, from that exact checkout's ops/monitoring directory:
../../bin/6529 ci
../../bin/6529 run generate:check
../../bin/6529 run check
MONITORING_ENVIRONMENT="$membership_monitoring_environment" \
MONITORING_COMMIT_SHA="$membership_monitoring_sha" \
  ../../bin/6529 run deploy:source
```

The source command additionally requires the approved `AWS_CLI_PATH`,
`SOURCE_ACCOUNT_ID`, `MONITORING_ACCOUNT_ID`, `MONITORING_EVENT_BUS_ARN` and
`SOURCE_ARTIFACT_BUCKET` environment settings. Preserve the existing optional
`SOURCE_CLOUDFORMATION_ROLE_ARN` and alarm topic configuration. Leaving
`SOURCE_ALARM_TOPIC_ARN` unset preserves the existing topic; setting it empty
disables it. The monitoring OIDC identity cannot deploy the source stack. See the
[isolated monitoring runbook](../ops/docs/operations/isolated-operational-monitoring.md#deploy-and-connect-sources)
for identity, subscription-capacity, termination-protection and delivery checks.

## Closed controls

| Workflow input                         | Default    | Allowed activation                                                                |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `membership_runtime_mode`              | `inactive` | `staging-fixture-v1`, `staging-controlled-v1` or `staging-backfill-v1` in staging |
| `membership_worker_mapping_enabled`    | `false`    | `true` only with an active staging runtime mode                                   |
| `membership_dispatch_schedule_enabled` | `false`    | `true` only with an active staging runtime mode                                   |

Malformed values, unrelated services, wrong regions and production activation are
rejected. Compiled CloudFormation uses booleans, not boolean-looking strings.
Deployment-owned stage/region/mode/queue identity is frozen before shared secrets
load. Production is pinned to `prod`/`us-east-1`; active modes to
`staging`/`eu-west-1`. The controlled mode uses the application database only
when explicitly selected in staging.

The runtime IAM status event is `{"operator_action":"membership_runtime_status_v1"}`.
It reports mode and queue identity without loading secrets or accessing MySQL.
Dispatcher status also reports the exact rule identity and schedule control.
An inactive SQS event throws so an accidentally enabled mapping cannot silently
delete work. There is no HTTP endpoint, Function URL or arbitrary operator command.

Fixture work requires `membership_runtime_drill_v1`, the code-owned ownership
marker and fixed profile/group targets. The internal database selection overrides
secret-loaded defaults without changing `DB_NAME`; failed initialization stops
before the callback. Fixture control tables are not exported application entities
and are never created by the production schema scope. Existing credentials are
reused only after closed staging setup verifies access; no fallback to the app
database or automatic broadening of grants is permitted.

## Delivery and recovery

The worker has 60-second timeout, 2048 MB memory, reserved concurrency two, batch
one and maximum mapping concurrency two. The work queue has 360-second visibility,
four-day retention and a 14-day DLQ with `maxReceiveCount=5`. Both queues use managed
SQS encryption. Its role can consume the exact work queue and read the regional
configuration secret; it cannot send a continuation or invoke another Lambda.

A hint contains a versioned target plus the exact requested-version/reservation
pair. That pair permits the worker to consume its committed dispatcher reservation;
it conveys no eligibility or lease authority. Stale hints cannot bypass a newer
request, retry backoff, parked target, active lease or checkpoint fence.

Each invocation has at most 45 seconds of application budget, with finalization
reserves and actual statement deadlines. The fixture configuration evaluates two
groups and at most one quantum per invocation. A yield acknowledges only the
committed checkpoint; continuation requires a later independent dispatcher tick.
Unknown commit outcomes are reconciled from durable state, not retried as assumed
rollbacks. Failure attempts and parking are durable per requested version.

GC retains the current publication and unexpired active runs. It writes a first
retirement time before waiting reader grace; original completion time is retained.
Bounded pending slots and raw member cursors prevent a locked prefix from pinning
all later work. Empty lockable results do not prove an empty generation. GC cannot
provision its own checkpoint or claim source coverage.

## External dispatch and independent recovery

The dispatcher has 512 MB memory, a 30-second timeout and reserved concurrency
one. Its EventBridge rule runs once per minute only when explicitly enabled.
Admission requires the exact native scheduled-event shape, account, region and
rule, with a two-minute age limit and 30-second future-clock allowance. Deployment
controls and execution credentials are captured before loading shared secrets.
The SDK uses one send attempt, an absolute send deadline and physical HTTP abort.

Two persisted scan lanes alternate: due time and target primary key. Their fixed
cutoffs/high bounds and raw cursors progress past locked or rescheduled rows across
cold starts. Each tick examines at most 40 raw candidates and 20 per lane. Raw
positions still advance when both lanes encounter the same target, but an
invocation attempts each normalized target only once. A worker checkpoint during
the tick therefore cannot cause a second lane to send another page immediately.
Control and target transactions are separately bounded, and a 120-second
reservation is committed before send. A send failure or lost acknowledgement
cannot undo a possibly accepted message; finite reservation expiry permits a
later tick to retry.
The dispatcher never scans expired leases as a substitute for the target protocol,
resurrects a parked target, or writes a worker lease/checkpoint.

These are fixed closed-fixture limits, not a production latency SLA. Forty raw
positions per minute permit at most 57,600 candidate attempts per day before
multi-page work, duplicate positions, skipped rows and time budgets reduce useful
throughput. A target moved beyond the fixed due cutoff can be reached by the
independent primary-key lane. An attempt lost after cursor commit remains eligible
for that lane or a later sweep; no fixed recovery time is promised for a large
target population or repeated interruption. Keep both bounds fixed during a sweep.

The deployed fixture uses a 120-second reservation with a one-second send limit
and two-second target transaction limit. Short one-second reservations in focused
tests are not deployment settings. The reservation suppresses redispatch; it is
not a worker execution deadline. A delayed hint can still claim when its exact
request/reservation pair matches the locked target. A newer reservation makes it
stale. The queue's 360-second visibility starts when a worker receives a message;
it is not an initial delivery delay. Cold starts and queue backlog can still
produce duplicate hints, which the worker must fence. Production remains inactive;
any later activation requires measured capacity and latency acceptance.

GC has seven seconds reserved independently of dispatch. The heartbeat is one
only when dispatch returned without failed sends, a busy control row or budget
exhaustion, and GC succeeded. `DispatchControlBusy` and `DispatchBudgetExhausted`
are bounded zero/one Count metrics for each tick. The existing enabled-schedule
heartbeat alarm detects three consecutive missing or zero heartbeats; these
metrics distinguish stalled/degraded ticks from healthy idle ticks. Due-age and
parked metrics describe the bounded rows observed, not a global table count.
The EventBridge delivery DLQ and Lambda asynchronous failure destination share a
separate encrypted failure queue; they do not use the worker's processing DLQ.

## Closed staging fixture

The `customReplayLoop` carrier accepts exactly one `operator_action` property:

| Action                                    | Effect                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `membership_runtime_fixture_preflight_v1` | Read-only server identity, direct CREATE-grant observation and existing fixture schema inspection                                  |
| `membership_runtime_fixture_prepare_v1`   | Fixed database creation if absent, at most four approved table CREATEs, then one bounded source/setup quantum once schema is ready |
| `membership_runtime_fixture_status_v1`    | Bounded ownership, source/job, candidate, target, run and publication evidence                                                     |
| `membership_runtime_fixture_advance_v1`   | One guarded, code-owned scenario transition or correction of the held transport message                                            |
| `membership_runtime_fixture_db_proof_v1`  | Natural lease expiry/reclaim, stale-token fencing and concurrent reader/publication/GC evidence on the fixed database              |
| `membership_runtime_fixture_cleanup_v1`   | Guarded shutdown/grace check, then at most 128 rows from one fixed owned table                                                     |

There are no caller-supplied IDs, SQL, database names, grant changes or AWS control
operations. Prepare and database proof require at least three minutes of remaining invocation time;
other actions require 45 seconds. Each setup transaction has its own deadline and
statement cap. Reinvoke prepare until it reports READY; do not replace these
committed quantums with manual seed SQL. GC and dispatcher control rows are
provisioned only with the completed source setup.

The exact manifest includes 21 schema objects, including TypeORM's generated-column
metadata receipt, three fixed profiles and 36 referenced broad groups. The initial
job exercises all 24 non-catalogue source receipts, three committed input pages,
the TDH completion barrier and a separate catalogue mutation. FULL fanout then
requests actual child PROFILE runs. Status does not fabricate a completed horizon
or prove the application database is bootstrapped.

Enable the reviewed fixture worker mapping first and its dispatcher schedule last.
Record actual rule/mapping states, source/artifact identities, distinct EventBridge
events, Lambda request IDs, SQS message IDs and durable run/checkpoint progression.
More than sixteen independently scheduled worker invocations must advance one
real generation; local loops or repeated direct worker invocations do not satisfy
that gate.

The transport profile deliberately holds the first message after an actual
checkpoint commits. The same message must exhaust the queue's natural receive
policy and appear in its DLQ while unrelated targets keep progressing. Preserve
message/run/checkpoint evidence before invoking the closed correction action and
performing explicit bounded redrive. Verify same-generation continuation and
current publication. Queue delivery failures and database retry/parking are
separate evidence; neither substitutes for the other.

The first post-baseline request enters `MISSED_WAKEUP`. The dispatcher records one
fixed LONG-target send failure only after its real availability reservation commits,
then throws before sending. This is a controlled pre-send failure, not an AWS
service error. The next source transition requires the exact receipt, natural
reservation expiry and an actual resumed partial run. No availability, attempt,
lease or source counter is repaired to recover the missed delivery.

The source-change scenario supersedes an active generation and retains its prior
publication. The boundary scenario first records a real future horizon while a
PENDING grant remains false, then crosses that natural horizon and proves
supersession and a fresh false publication. Explicit GRANTED and DISABLED source
mutations prove addition/removal separately. The empty subject publishes zero
members. A missing canonical transport identity then exercises three actual
failure/backoff attempts and parking while independent work progresses. A FULL
run captures its high bound with that identity absent; exact restoration creates
its own PROFILE request beyond the bound. Parent acknowledgement must leave that
request intact, and all child publications must converge.

Poll status and advance about every 30 seconds while waiting for supersession or
fanout completion. These evidence-only transitions retain observed terminal run
IDs before ordinary GC can remove them. Record each precondition and durable
result; local tests are preparation evidence only.

Worker errors, throttles, OOM, queue age over ten minutes for two periods, and any
visible DLQ message have service-owned alarms. Queue emptiness alone does not
prove database progress. Combined staging acceptance must still exercise the real
dispatcher/SQS/evaluator worker across more than sixteen independent invocations,
source/lease/replay/expiry/retry cases, natural DLQ delivery and correction, GC and
fresh related E2E. Local MySQL tests do not replace that proof.

After the scheduled scenarios, stop dispatch first, settle in-flight work, then
deploy the worker inactive with mapping disabled. Independently verify those AWS
states before invoking the database proof. Its bounded invocation owns a real
90-second lease, waits for natural expiry, claims a successor and rejects the old
checkpoint/completion/failure writes. It then retains a real REPEATABLE READ
reader while replacing a positive publication, verifies retirement/current-run
protection, releases the reader and waits the real 120-second grace before GC.
The result is explicitly database-only evidence. An interrupted reader overlap
remains `INTERRUPTED`; it cannot silently become a successful replay. Lease tokens
are private durable state and are removed from all carrier responses. Record DONE
and retain the evidence before bounded fixture cleanup.

Production materialisation activation requires the deferred live drill in #2090.
This inactive M6–M7 release can promote after related green staging E2E while
keeping source tracking, processing triggers, materialized reads and shadow off.
