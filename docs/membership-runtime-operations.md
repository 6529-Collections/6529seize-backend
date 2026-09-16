# Inactive membership runtime operations

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

The runtime packages the fenced worker, external dispatcher and GC. Existing
authorization readers and producer jobs remain in use. Both runtime services
default to inactive; deployment alone does not provision source readiness or
start background work. The only activation mode is the isolated staging fixture.

## Deploy in dependency order

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

## Independent operational monitoring

The worker and dispatcher stacks install their own alarms. Central
structured-error monitoring is a separate deployment: the generated monitoring
templates admit `membershipRefreshLoop` and `membershipRefreshDispatcherLoop` in
both collectors. The source templates include each function's `/aws/lambda/`
subscription, relay allowlist entry and Lambda Errors/Throttles alarms. These
platform alarms treat missing data as non-breaching while inactive. The enabled
dispatcher heartbeat remains service-owned. The central source alarms coexist
under distinct names; this change does not replace existing alarms or their
delivery topics.

During combined staging acceptance, use the service-owned worker/dispatcher
alarms and direct CloudWatch logs. New central structured-log coverage remains
**pending** until the authorized M2–M5 main merges and the separate monitoring
rollout complete. `Deploy operational monitoring` accepts reviewed merged `main`
source only. Do not merge early or change that boundary to install staging
coverage.

In Phase 4, after the reviewed membership changes are on `main`, complete the
following sequence for staging and then production. Keep production runtime
controls inactive. Record `operational_deployments: ["monitoring"]` on the
existing Coordinator backend release part; that declaration records required
work and does not deploy it.

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

| Workflow input                         | Default    | Allowed activation                                             |
| -------------------------------------- | ---------- | -------------------------------------------------------------- |
| `membership_runtime_mode`              | `inactive` | `staging-fixture-v1` only for the worker/dispatcher in staging |
| `membership_worker_mapping_enabled`    | `false`    | `true` only with the staging fixture mode                      |
| `membership_dispatch_schedule_enabled` | `false`    | `true` only for the staging fixture dispatcher                 |

Malformed values, unrelated services, wrong regions and production activation are
rejected. Compiled CloudFormation uses booleans, not boolean-looking strings.
Deployment-owned stage/region/mode/queue identity is frozen before shared secrets
load. Production is pinned to `prod`/`us-east-1`; fixture mode to
`staging`/`eu-west-1`. There is no shared-database work mode.

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

Production promotion requires the combined live drill and related green E2E.
Production promotion keeps both runtime services inactive
and leaves all normal producer/read activation for later increments.
