# Inactive membership worker operations

This increment packages the fenced worker and GC. Existing authorization readers
and producer jobs are unchanged. External scheduled dispatch and the closed
staging fixture setup are a subsequent increment; deploying this package alone
does not provision source readiness or start background work.

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
   disabled mapping and alarms. No frontend deployment is required.

The run index uses `ALGORITHM=INPLACE, LOCK=NONE`, a one-second metadata lock wait
and 120-second DDL client deadline. Inspect the complete plan before either
addition. If the table succeeds but the index fails, keep the table and rerun this
scope after resolving the cause. A client timeout does not establish rollback;
inspect actual schema through the same idempotent scope. Never drop/rebuild data
as retry cleanup. Manual full synchronization cannot bypass these additions.

## Closed controls

| Workflow input | Default | Allowed activation |
| --- | --- | --- |
| `membership_runtime_mode` | `inactive` | `staging-fixture-v1` only for the worker in staging |
| `membership_worker_mapping_enabled` | `false` | `true` only with the staging fixture mode |

Malformed values, unrelated services, wrong regions and production activation are
rejected. Compiled CloudFormation uses booleans, not boolean-looking strings.
Deployment-owned stage/region/mode/queue identity is frozen before shared secrets
load. Production is pinned to `prod`/`us-east-1`; fixture mode to
`staging`/`eu-west-1`. There is no shared-database work mode.

The sole IAM status event is `{"operator_action":"membership_runtime_status_v1"}`.
It reports mode and queue identity without loading secrets or accessing MySQL.
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

Worker errors, throttles, OOM, queue age over ten minutes for two periods, and any
visible DLQ message have service-owned alarms. Queue emptiness alone does not
prove database progress. Combined staging acceptance must still exercise the real
dispatcher/SQS/evaluator worker across more than sixteen independent invocations,
source/lease/replay/expiry/retry cases, natural DLQ delivery and correction, GC and
fresh related E2E. Local MySQL tests do not replace that proof.

After the combined authorized staging drill, stop dispatch first, settle in-flight
work, then deploy the worker inactive with mapping disabled. Retain reader grace
before fixture cleanup. Production promotion keeps both runtime services inactive
and leaves all normal producer/read activation for later increments.
