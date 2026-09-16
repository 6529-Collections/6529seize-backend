# Membership refresh schema and publication contract

Status: inactive schema foundation and runtime implementation contract. The
additive schema comes from PR #1739; the current SQL/specification baseline is
defined by PR #1740 and [eligibility-spec.md](eligibility-spec.md). No membership
producer, dispatcher, worker or materialized reader is enabled by this contract.
Implementation work remains tracked by [#2075](https://github.com/6529-Collections/6529seize-backend/issues/2075).
The overlapping July runtime in #1822 remains unmerged and must be reconciled
with this contract and the current eligibility baseline before any useful work
is incorporated into replacement PRs.

## Decisions

Publish an immutable **profile generation**, not an in-place whole-group
replacement. A PROFILE run evaluates a bounded page of the canonical group
catalogue at a time. GROUP and FULL runs durably fan out PROFILE requests using
bounded primary-key pages. Thus even a group matching every profile is handled
across many invocations, with no million-row delete/insert or initialization
transaction. One identity row per profile is a system invariant.

Freshness is a vector of **committed source versions**, plus a monotonically
increasing group-catalogue version. UUIDs identify jobs, runs and leases;
BIGINT counters order changes. Millisecond fields measure age and scheduling;
they never prove freshness or deduplicate source completion.

A reader uses clean parts of a published profile generation and directly
evaluates affected groups, including groups absent from the stored positive
membership rows. An individual dirty group does not disable all materialized
reads. No global FULL-ready flag is required. Missing evidence means fallback,
never an authoritative empty result.

## Tables

| Table | Key and purpose |
| --- | --- |
| `membership_source_states` | `(scope, target_id, dimension)` version and active-job barrier. GLOBAL uses target `*`; PROFILE uses canonical profile ID. |
| `membership_source_jobs` | Source key plus durable producer `job_id`; stage/checkpoint, RUNNING/FAILED/COMPLETED state, start/completion versions and error evidence. |
| `membership_group_versions` | Group ID, latest catalogue version and deletion tombstone; indexed by catalogue version to find changed rules. |
| `membership_refresh_targets` | `(PROFILE/GROUP/FULL, target_id)` persistent coalesced requested/completed counters, active run pointer, retry time and errors. FULL uses `*`. |
| `membership_refresh_runs` | UUID, captured request/spec/catalogue/source versions, keyset cursor and high bound, lease fencing, progress and completion. |
| `membership_generation_members` | `(run_id, group_id)` positive results for a PROFILE run, with a profile/run/group lookup index. Rows belong to an unpublished candidate until publication. |
| `membership_publications` | Profile ID → completed PROFILE run ID, including generations with zero positive rows. The single-row pointer is the atomic publication boundary. |

Types live in `src/membership/membership-schema.types.ts`, outside the entity
barrel (the synchronizer passes every barrel export to TypeORM). All new
identity and UUID columns use binary collation consistently. Store and compare
canonical application IDs; keyset queries must use the source column's actual
collation and ordering. Counters are decimal strings in persistence types to
avoid loss above JavaScript's safe integer limit. Future SqlExecutor repositories
must normalize its native number/bigint results to decimal strings before
storing version vectors as JSON; entity typings do not change driver decoding. JSON source-version vectors
have one unique entry per source key; reject missing, duplicate, unknown or
malformed entries before considering any group ready. These are application
contracts, not database enum, foreign-key or CHECK constraints.

The July draft tables `user_group_members`, `membership_refresh_requests`,
`membership_materialization_states` and `membership_watermarks` are deliberately
not mapped by these entities. Any surviving July data stays untouched and can
never become readiness evidence for this protocol. Their cleanup is separate
work after retention/rollback review. Existing `wave_score_refresh_requests`
columns and TypeScript types are unchanged; there is no shared-base refactor.

## Source mutation and completion protocol

Every source key is provisioned explicitly. An absent key is **unknown**, not
version zero. Bootstrap must inventory producer coverage before initializing
zero-version states. GLOBAL and PROFILE versions both participate: a global
change cannot be hidden by a profile-local version. Dimensions are TDH_XTDH
(including derived levels), RATINGS, OWNERSHIP, DELEGATIONS, GRANTS, IDENTITY and
GROUP_CATALOG. Fine-grained dimensions may be added only with corresponding
producer, evaluator and reader coverage. Dimensions identify mutated inputs,
not Lambda names: a delegation reconsolidation must also barrier/version its
TDH_XTDH, OWNERSHIP and IDENTITY effects as applicable. Likewise, xTDH grant/rating
revocations must cover those dimensions. Reader dependency analysis must include
derived inputs such as levels, not just the rule's directly named metric.

For a single-transaction mutation:

1. Lock affected source-state rows in a stable order on the primary.
2. Persist the source mutation, increment each affected version using SQL
   arithmetic, and upsert/increment the appropriate refresh target in the
   **same transaction**. Set `available_at_millis` to the database time and
   reset retry bookkeeping for the new requested version.
3. Commit, then optionally send a wakeup. Losing the wakeup is harmless: the
   target remains discoverable by a recovery poll. Rollback leaves neither new
   inputs nor a version/request visible.

For a multi-transaction producer:

1. Before its first write, lock source-state rows, insert a RUNNING source job
   under a stable producer ID and increment version/active_jobs atomically.
   Duplicate delivery of that ID resumes the existing job; a COMPLETED job
   never starts again. Every reader/refresh now treats affected dimensions as
   unready, so a mark-before-mutation cannot be consumed as completion.
2. Persist stage/checkpoint progress with each bounded source write. Serialize
   conflicting writers to the same source dataset; a new overlapping cycle
   waits for or resumes the active cycle. If later implementation parallelizes
   disjoint jobs, it must fence source writes as well as refresh publication.
   A version counter alone does not stop an older producer overwriting newer
   source values. Lock global keys before profile keys consistently.
3. After all eligibility inputs and derived outputs commit, atomically change
   RUNNING → COMPLETED, increment version, decrement active_jobs and enqueue
   the refresh target. Repeated completion must be a no-op under the same job
   row lock; it cannot increment twice or clear another active job.
4. FAILED retains the active barrier. Recovery resumes/repairs the source and
   only then completes it. Timeouts and expired worker leases never clear a
   source barrier automatically. Conflicting queued jobs remain durable in
   the existing producer orchestration; refresh targets are not a source-job
   work queue.

TDH and downstream xTDH share a durable cycle ID and **one TDH_XTDH job**. TDH
completion only advances its stage. Complete the job and request refresh only
after xTDH, identity metrics and derived levels for that same cycle have all
committed. On current main, the xTDH universe phase commits level updates in
`RecalculateXTdhUseCase.handleUniversePhase`, then enqueues a distinct STATS
phase; `RecalculateXTdhStatsUseCase.handle` publishes the inactive statistics
slot last. Propagate the cycle ID through **both** SQS phases and make durable
cycle completion follow successful stats activation. Returning from the
universe handler or merely sending STATS is not full-cycle completion. Delayed stages from an older cycle cannot complete a newer job.
Delegation/consolidation jobs follow the same protocol and request affected
profiles after commit, including `handleDelegations` persistence,
`reconsolidateWallets` TDH/NFT/balance consolidation and primary-address effects,
or FULL when the affected cohort cannot be bounded
safely. Overlapping TDH and delegation jobs have independent barriers; readers
and publishers must check both dependencies where used.

This replaces the proposed routine 02:00 FULL schedule in the later worker;
#1739 neither installs nor removes any schedule. Keep explicit bootstrap and
recovery FULL requests and a dirty-work recovery poll. See #2065, #2067, #2073.

All eligibility writers must participate before read cutover: single and bulk
REP/CIC, lost-credit and over-rate revocation, grant single/bulk status and
boundaries, NFT/external ownership, profile lifecycle/consolidation, group
rules/lists/visibility and wave-group selection. A producer coverage audit and
tests through the actual mutation methods remain required by #2067.

## Group catalogue protocol

Group rule/list/visibility changes and deletion or wave-group selection changes
increment GLOBAL `GROUP_CATALOG` on target `*` in their transaction and upsert
`membership_group_versions` for every affected group with that value. A change
to a shared list must cover every referencing group, or use a barrier while
bounded fanout completes. Keep deletion tombstones until no retained readable
generation predates them. A group recreated with the same ID gets a newer
version. Bootstrap versions every existing candidate group before publication.

A PROFILE run captures catalogue version C before its first page and a high
bound for its catalogue traversal. Changes during traversal are safe only
because all groups with latest catalogue version > C are overridden by the
reader, even if absent from that run's rows or inserted behind its cursor.
Never advance C to a later value at completion. A GROUP fanout captures a
profile high bound and checkpoints requests as it walks; profile creation must
also enqueue its own PROFILE request. Completion of a GROUP/FULL run means
**fanout completed**, not that its child profiles are published or current.
Observe child target/publication progress separately when reporting backfill
completion. Do not clear group-version evidence when fanout completes.

## Bounded refresh and publication

A target's requested counter is durable and never reset or deleted. Repeated
triggers coalesce into the same row. `available_at_millis` is non-null while
pending or retryable and null only after fully acknowledged or parked failure;
a recovery scanner also checks expired active runs. New invalidation reactivates
parked work. The requested/completed counter difference remains the truth.

Claim under a target row lock; capture request version V, allocate a run UUID,
set `active_run_id`, and lease it with a random fencing token and DB-clock
expiry. Only the matching active run/lease token may checkpoint, finish or
acknowledge. Reclaiming rotates the token, so an old invocation cannot commit
late. Lease expiry alone does not authorize a second publisher.

For PROFILE runs capture the required GLOBAL and PROFILE source-version vector,
spec version, evaluation time and catalogue version. Each group page reads
**consistent primary inputs and definitions**, bypassing replica routing and
all stale group/identity caches. Start a short consistent-snapshot transaction,
verify the captured source versions and active barriers, compute/write a
bounded candidate page, and checkpoint its cursor/count/version in that same
transaction. Use keyset pages of canonical group IDs; GROUP/FULL runs instead
page canonical identity profile IDs and atomically enqueue requests with their
checkpoint. Never load every identity or seed all state rows in one statement.

Separate transactions may contribute to one candidate only while all captured
non-catalogue source versions stay equal and their active-job counts stay zero.
At final publication, lock/recheck the relevant current source-state rows on
the primary, together with target/run/publication rows. A concurrent source
commit either precedes that check (reject the candidate) or follows publication
(and immediately invalidates its dependent results). Do not rely on a repeatable
read's old snapshot for this final guard. GROUP_CATALOG is checked using the
per-group override protocol above; an active catalogue barrier is not publishable.

After the last page, one short transaction marks the PROFILE run COMPLETED,
swaps the profile publication pointer and advances the target's completed
counter to V. It may advance only when this is still the active run. If the
requested counter became V+1, acknowledge at most V and leave the target queued;
never delete the newer request. A stale source vector requires SUPERSEDED and
a fresh candidate, not publication. An existing complete publication remains
available with per-group freshness checks while a replacement runs. Crashes
before the commit expose no partial result; crashes after it require no replay
of completed work. Negative membership is represented by the completed pointer
and absence of that group in its immutable rows.

Refreshes have both time and row/work budgets. Stop before the Lambda deadline
with time reserved for commit/checkpoint; bound SQL execution and external calls
too. If a single rule cannot meet the page budget, it requires a smaller
producer/evaluator checkpoint strategy or an explicit resource limit before
activation. A group-count limit alone is not a time bound. Candidate and old
run garbage collection is bounded, cannot delete a currently published run,
and must retain generations for the reader transaction/grace period.

Use an **external scheduled dispatcher** to lease pending database targets and
send bounded SQS work. Workers checkpoint and return; they do not send chains
to their own trigger queue. The poll is recovery as well as progress, so a crash
between commit and notification converges. Implement the dispatcher/queues and
verify >16 invocations in the later infrastructure PR (#2071/#2072); this schema
introduces none of that runtime.

## Readiness and time-dependent rules

For a targeted group, read a coherent primary snapshot containing the publication,
COMPLETED PROFILE run (matching profile ID and current evaluator spec), current
canonical group, latest group version, and relevant source keys. Require complete
producer/bootstrap evidence, no relevant active job, and exact matching GLOBAL
and PROFILE versions for every dimension that the **current** rule depends on.
Require the group's catalogue version <= the run's captured C. Only then can
membership-row presence/absence answer authorization. Never join a publication
to a GROUP/FULL run. Missing source state, group-version evidence, publication,
run, invalid metadata or errors use authoritative direct evaluation.

For all-groups queries enumerate the current candidate catalogue, including
possible new memberships. Overlay direct results for changed groups and groups
whose source dependencies fail readiness; remove stale positives as well as
add new positives. Deleted/invisible/noncandidate groups are excluded under
current-main semantics. Re-evaluation and clean membership assembly must share
a coherent primary read context. Cached readiness must itself be version-checked;
a fixed TTL does not provide authorization freshness. A large affected set may
justify full direct evaluation, but one poison group must not force it.

Time is an input for grant activation/expiry even without a writer. Capture one
evaluation time per run and the earliest future relevant transition across all
candidate rules, **including currently false rules**, in `valid_until_millis`.
When crossed, time-dependent groups need direct evaluation and refresh; a null
value is valid only after proving there is no future boundary. A refresh's lease
must not extend that horizon. Direct/shadow checks must use the same intended
rule semantics from [eligibility-spec.md](eligibility-spec.md), retaining the
shared direct/SQL conformance coverage when adding a primary-read evaluator.

## First runtime increment: repository contracts

The isolated contracts are implemented in `src/membership/membership-*.ts`.
They do not connect existing producers or authorization readers. Callers use
`withMembershipPrimaryTransaction` at the transaction owner, then pass its
`MembershipPrimaryContext` through every source input write and repository call.
Contexts cannot nest an unproven connection, be forged, survive transaction exit,
or inherit an older request cache. Opted-in API and TypeORM transactions use
explicit repeatable-read isolation; locking reads remain current primary reads.
Every repository failure marks the whole transaction rollback-only, even when
the callback catches it. External effects must follow a successful commit.

`MembershipSourceStatesDb.provision` is explicit and records one completed
`bootstrap:` receipt with the caller's audited coverage revision. Reads require
that receipt as well as the state row. An existing unproven state is rejected,
never silently reset or blessed; fixture/bootstrap evidence is not proof of
unwired production producer coverage. Source counters and timestamps are selected
as decimal strings before driver JSON conversion and validated at the boundary.

Profile source mutations lock matching GLOBAL dimensions as guards without
incrementing those global versions. Multi-stage PROFILE jobs automatically add
matching GLOBAL keys to their barrier set. This first contract conservatively
serializes jobs touching the same dimension across profiles; parallel disjoint
profile jobs need a later dataset-writer protocol. The supplied source set is
hashed into durable job progress. Each stage, failure and repair rotates a
decimal checkpoint revision, so a delayed invocation cannot act merely because
stage/cursor text matches again. Completed job identities remain idempotent
after another cycle starts. A TDH_XTDH job accepts final completion only at
`STATS_ACTIVATED`; producers must checkpoint actual successful statistics
activation and all derived outputs for the same cycle before using that stage.
This check does not replace later tests through the real TDH/xTDH producers.

Single-transaction catalogue edits require explicit affected group versions and
tombstones. Multi-stage catalogue jobs are rejected until their bounded group-
version fanout contract is implemented. Source jobs are not a producer work
queue: conflicting job identities remain pending in caller orchestration.

Transaction owners must acquire all required source keys first in canonical
GLOBAL-before-PROFILE order (including their provisioning/job receipts), then
affected group-version rows, then refresh targets in sorted scope/target order.
A request-only transaction takes only the final target locks and never reaches
back for source locks. Do not compose `request()` followed by a source mutation
in one transaction. Ordinary deadlock/lock-timeout errors still abort the whole
transaction; retry the owner from its stable source-job/checkpoint identity.

The IAM-only staging diagnostic in `customReplayLoop` runs source/job scenarios
inside an intentionally rolled-back primary transaction, including any temporary
GLOBAL evidence. It separately proves concurrent durable target coalescing and
cleans only invocation-generated fixture keys. Real local MySQL tests cover
committed source concurrency, partial-write rollback and stale recovery. No
production bootstrap, normal background schedule or materialized read is enabled.
Later evaluator/worker/dispatcher validation must prove its real end-to-end path.

The focused repository increment retains these acceptance requirements:

1. Normalize source keys, dimensions and decimal-string counters at the
   repository boundary. Reject malformed or incomplete version vectors; an
   absent source key remains unknown. Cover native number/bigint decoding and
   values above JavaScript's safe integer range without lossy conversion.
   Reject unsafe numeric results; large values must arrive as bigint or valid
   decimal strings.
2. Accept an explicit caller-owned primary transaction for source-version and
   refresh-request writes. Lock source keys in stable global-before-profile
   order and use SQL arithmetic for increments. Source mutation, version and
   request must commit or roll back together; do not create readiness evidence
   by silently provisioning missing source keys.
3. Implement durable job start, checkpoint, failure and completion operations
   under source/job row locks. A duplicate start resumes the same job, a
   completed job cannot restart, and completion increments/decrements exactly
   once. Failed jobs keep their barriers; one job cannot clear another's work.
4. Define the primary-read context that later evaluators will use, including
   bypass of replica routing and stale caches. Keep current runtime readers
   unchanged in this increment. Repository tests must prove which connection
   executes the reads rather than assuming a transaction implies primary use.
5. Test rollback after each write boundary, duplicate completion, overlapping
   jobs, concurrent request increments, stable lock ordering and failed-job
   recovery. Verify that concurrent requests coalesce without losing increments
   and that all barriers/counters remain correct across competing transactions.

Wiring every real writer, propagating durable TDH/xTDH cycle IDs, bounded
dispatch/worker infrastructure, publication, shadow validation and reader
cutover belong to later focused increments. The repository PR alone does not
close the producer-coverage, consistency or runtime gates in #2065–#2067 and
#2070–#2074.

## Rollout and remaining gates

### Primary evaluator increment

`PrimaryMembershipProfileEvaluator` implements specification 2 using bounded
primary input reads. Capture requires exactly one identity row for the profile,
completed provisioning evidence and idle source barriers. The immutable seed
records its consolidation key, fixed evaluation time, group high bound and thirteen
source entries: GLOBAL catalogue plus GLOBAL and PROFILE versions for the other
six dimensions. Missing evidence is unknown; missing/duplicate identities and
unsupported numeric domains are explicit errors rather than empty generations.

The evaluator preserves exclusion-before-inclusion, configured criteria combined
with AND, and grant eligibility determined by status. Grant dates still contribute
conservative future horizons, including rules that are currently false and rules
short-circuited by another criterion. It reads these bounded metadata fields before
such shortcuts. Existing public permission readers continue using their current
implementation; this library does not activate materialized membership.

Candidate discovery uses an indexed bounded list lookup and the stored pure-group
classifier. Dense profile lists use a bounded canonical group scan instead of an
unbounded filtered UNION. Source key ordering follows the actual SQL column
collation. Ratings, wallet ownership, grant tokens and JSON token lists use bounded
raw windows. A profile's wallets come from its one captured consolidation key;
multiple identity rows are an integrity error, not a second aggregation path.

`evaluateQuantum` returns a completed group prefix and either `PAGE_COMPLETE` or
`INPUT_PENDING`. The latter contains one strictly decoded `ActiveInputV1`: fixed
fingerprints, the active group's version, a scalar stage and bounded cursors or
exact counters. The complete persisted cursor is capped at 32 KiB. It never stores
growing input arrays or acknowledges an unfinished group. Soft yielding requires
actual input/stage progress; query timeout or missing evidence throws and rolls
back the transaction. A changed active group restarts only that group's inputs;
unrelated catalogue changes do not rewrite captured catalogue C, completed prefix,
evaluation time or high bound. The other twelve source versions must still match.

The optional `SqlExecutionBudget` on `withMembershipPrimaryTransaction` binds an
absolute monotonic deadline, per-statement limit, finalization reserve and lock
wait to the leased writer connection. Cached query options still receive live
checks. Physical connection disposal and explicit callback settlement cover
stalled reads, DML, lifecycle statements and callbacks that never return. Commit
outcomes distinguish not sent, uncertain and acknowledged; a restoration failure
after an acknowledged commit does not turn it into a rollback. Reconcile uncertain
outcomes through a new transaction. Legacy callers opt out by omitting the budget.

The new nonunique index `idx_user_groups_pure_visible_id` on `community_groups`
requires the explicit `membership-evaluator-index` scope. That scope uses only
`UserGroupEntity`, rejects an absent table or any unrelated schema drift before
DDL, verifies full ascending visible index columns, and applies the pinned online
addition. Metadata-lock acquisition is limited to one second. DDL has a separate
120-second client deadline with physical disposal and uncertain-outcome reporting;
it is not transactionally reversible. Rerun the same scope to inspect exact state
after a lost acknowledgement, never drop/rebuild the index as retry cleanup.

Manual full schema synchronization connects without automatic sync and rejects
pending controlled membership DDL before preserving its existing synchronization
of unrelated entities. Scheduled maintenance remains no-sync. Fresh disposable
Jest databases initialize their fixture schema explicitly before invoking that
guard; no local/test escape flag is added to the deployed handler.

These bounds do not establish production cutover capacity. Shared plan reuse,
actual Aurora query plans, realistic sustained writes/fanout and API p95/p99 remain
part of #2074; producer coverage and reader fallback remain separate increments.

### Staged rollout

1. Deploy only `dbMigrationsLoop`, then invoke with `schema_scope=membership-refresh`
   (workflow input `db_schema_scope=membership-refresh`). This scope inspects
   TypeORM's plan, accepts only creation of the seven selected tables, executes
   those exact statements, and verifies a subsequent plan is empty. Existing
   table drift fails before executing any DDL. It skips unrelated full-schema
   synchronization, data migrations and maintenance.
   These seven new tables add no foreign keys or changes to preexisting tables.
   Verify a second sync produces no DDL and old wave-score/July rows survive.
2. Keep all current readers and source jobs operating as before. No frontend,
   OpenAPI or help-bot knowledge change is required for this internal schema.
3. Apply the explicit `membership-evaluator-index` scope before deploying the
   primary evaluator. Fenced checkpoints/publication and an external dispatcher
   follow as inactive runtime increments. Producer transaction/barrier coverage
   and per-group read fallback remain later increments. Deploy schema before
   producers, dispatcher/worker before enabling triggers, and keep read and
   background-work switches independent.
4. Initialize source/catalogue evidence, backfill and run shadow comparisons;
   measure real writes, broad groups, storage, lock time, queue age and API p95/
   p99 against warm/cold legacy behavior (#2074). At the reviewed scale of
   1,034,081 profiles and 9,936 mostly tiny explicit-list groups, PROFILE fanout
   trades predictable transaction bounds for potentially high evaluation work.
   Use shared immutable rule plans by version, indexed explicit-list lookups
   and set-based evaluation over bounded batches of profile runs; this layout
   does not require a separate SQL query per profile/group pair. Optimize with
   measured evidence. This schema is not a claim of cutover performance or readiness.
5. Require correctness/concurrency, current consumer conformance, realistic load
   and fresh staging E2E gates before enabling materialized authorization.
   #1739 Phase 3 requires its related staging E2E to pass, but does not close
   these worker/cutover issues or authorize production activation.

The pinned TypeORM MySQL driver creates secondary indexes inline in CREATE
TABLE; the real-MySQL test asserts every declared index appears in those seven
statements and exists after synchronization. Separate index/ALTER statements
on an existing table deliberately remain outside this create-only release
scope. Revalidate the plan contract when upgrading the driver. `downQueries`
are reversal descriptions and are never executed by the scoped operation.

MySQL DDL commits each CREATE independently. If a later statement fails, keep
the successfully created tables and rerun the same scoped invocation: it
replans and creates only the missing tables, then verifies the complete schema.
A fault-injection DB test interrupts the fourth CREATE and verifies recovery
creates exactly four remaining tables followed by a no-op rerun. Do not try to
roll back the prefix with DROP statements or claim a SQL transaction can make
the complete DDL plan atomic. No worker/readiness is enabled during this retry.
An existing-table mismatch still requires explicit review instead of repair
through this scope. Schema fixtures use Testcontainers and one database per
Jest worker, provisioned in `src/tests/_setup/globalSetup.ts`; they never use a
shared development, staging or production database.

Rollback retains all additive tables and existing authorization paths. Future
read rollback and workload disablement are separate controls. Never redeploy
an old July worker against this protocol or infer readiness from its tables.
