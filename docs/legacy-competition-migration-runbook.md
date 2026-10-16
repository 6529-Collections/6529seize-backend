# Migrate one legacy wave

Invoke `competitionMigrationLoop` in the AWS Lambda console with one JSON field:

```json
{ "wave_id": "24d811cd-3da6-4352-9619-ff5a226ade22" }
```

Use the staging function in `eu-west-1` or the production function in
`us-east-1`. The deployed function selects its own database/environment. AWS IAM
permission to invoke it is the authorization; no application operator allowlist,
wave membership, reason, acceptance record, completed pilot, cohort approval or
timed parity windows are required. The same payload works in both environments.
Deploying the function does not migrate anything. There is no schedule.

The code resolves the wave's immutable primary competition, copies configuration,
entries/content, votes, history, decisions, winners, outcomes and pauses in saved
batches, and catches up with writes accepted during copying. It compares the
original data with the native tables and old-endpoint projections. Once the data
matches and pending publication effects are drained, it performs a final comparison
under the ownership lock and transfers ownership atomically. Wave and drop URLs
are preserved. Signed voting, special capabilities and existing upper-threshold
metadata are retained; large content comparisons use pagination.

After the initial copy, a catch-up window containing only votes, credit spending,
runtime ranks, leaderboard snapshots and retained vote-time histories replays its
changed keys and refreshes live entry ranks and leaderboard ranks in bounded
batches. Entry ranks include participating entries and historical winners, with
published winner ranks retained. The active-only leaderboard keeps its separately
locked snapshot ordering. Both projections commit before the window is acknowledged.
Until every page finishes, native ranks are an incomplete shadow projection;
public readers continue to select legacy storage. Per-page commits do not advance
the applied watermark. Only the final refresh page acknowledges the target, and
comparison/cutover still reject any source change or incomplete refresh. Batch
limits are validated at 1..100 rows, so rank updates contain at most 100 CASE arms.
The refresh retains the
completed voter, decision, award and archive stages instead of copying them again
after every routine snapshot. The entire journal window since the last applied
watermark must qualify; configuration, content, decision or other captured changes
retain the conservative full refresh. The target watermark is acknowledged only
after the refresh commits. Independent comparison and the final ownership lock
remain mandatory. Deploy only `competitionMigrationLoop` for this correction;
existing legacy-owned checkpoints remain resumable without a schema change.

For a legacy-owned copy, earlier deployed migrators understand the same stage,
cursor, completed-stage and watermark fields. Their leaderboard refresh does not
repair live entry ranks, so a binary rollback can leave entry parity mismatches;
keep legacy ownership rather than accepting such a comparison. The release
operator should retain the stop, capture status and comparison diagnostics, and
check whether the deployed worker refreshes entry ranks. Resume the saved copy
with the reviewed correction only after its release gates pass; do not re-enroll,
clear parity failures or force cutover to work around a rollback mismatch.
The older migrator (`0f79fcc82`) uses a conservative full refresh on later journal
windows, which rebuilds entries but can reintroduce the convergence problem.
Stop the current invocation at a saved checkpoint before changing the migrator
version. Reverting the binary does not reverse competition ownership; an already
native competition still requires the guarded recovery procedure.

Capture rows in `competition_migration_changes` are durable migration evidence;
this implementation has no automatic journal-pruning job. Do not manually trim
rows needed by an in-progress migration or its recovery checkpoints. A missing
next journal watermark stops catch-up and retains legacy ownership. Preserve
the journal when investigating a stopped copy or planning rollback/re-migration.

Comparison freshness is measured when the independent comparison finishes.
After readiness passes, the Lambda calls live cutover once; that transaction
performs the final comparison and invariants under the ownership lock before any
ownership change. It does not repeat the same expensive check in a separate dry
run. The 60-second comparison age limit, watermark checks and mismatch rejection
remain in force. Deploy only `competitionMigrationLoop` for this correction;
an interrupted legacy-owned copy can resume from its existing checkpoint.

Completed waves preserve historical data exactly, including existing differences
between stored scores and individual votes or historical credits that exceed a
voter's current budget. Verification compares the native copy against the retained
source; it does not recalculate or repair historical scores, votes, winners or
outcomes. A newly introduced difference, missing runtime or orphaned native vote
still fails verification. Live waves additionally require aggregate and credit
consistency, checked before ownership changes. A competition that ends after a
live migration retains those native aggregate checks.

The legacy leaderboard snapshot worker leaves completed-wave snapshots unchanged,
including global stale-entry maintenance. Active/open-ended waves and pending final
decisions continue to refresh; explicit decision cleanup remains scoped to its wave.
Completion is rechecked under the execution lock before a worker writes. Deploy
`waveLeaderboardSnapshotterLoop`, then `waveDecisionExecutionLoop`, which also
refreshes weighted entries before its APPROVE pass. No schema, API or frontend
deployment is needed.

This verification correction requires only `competitionMigrationLoop`. No schema,
API or frontend deployment is needed. Reinvoking an already transferred completed
wave rechecks source fidelity without rewriting its data.

The primary competition's Activity feed combines retained legacy activity with
native vote history under either owner, including after a supported rollback and
later migration. Native primary votes also write a wave log in the same
transaction, with the exact native Activity ID (`<competition-id>:<sequence>`).
The combined reader emits that event once, retains its native timestamp, and
uses the linked log's complete contents and proxy attribution. Legacy-only logs
retain their original IDs and timestamps. Adjustment reasons are preserved.
New cutover audits record `voteActivityIdentity: NATIVE_ID_V1`: all native
primary writers must carry the exact-ID logging correction before that cutover.
These migrations need no timestamp-based deduplication, including after rollback
or clock skew. Only older cutovers use ownership intervals to filter unlinked
compatibility logs already covered by native history. Native siblings do not inherit primary
wave activity; normal wave/parent visibility and entry visibility still apply.

For a migration smoke check, compare the legacy `/waves/{wave_id}/logs` endpoint
filtered to `log_types=DROP_VOTE_EDIT` with the primary competition's
`/v3/waves/{wave_id}/competitions/{competition_id}/activity` before and after
transfer, including pages beyond the first. Check the frontend Votes → Activity
view as well as entries, scores, winners and awards. The 22 migration comparison
categories alone do not verify this feed.

The Lambda performs all checks and the switch. Nothing needs a human approval.
The response reports `COMPLETE`, `CONTINUING` or `PAUSED`. Large migrations queue
the same function automatically when an invocation runs out of its work budget;
checkpoints survive interruptions. Internal continuation metadata is generated by
the function; do not add it to a console event. A run can continue for up to 24
hours. Reinvoke with the same wave ID to resume a paused or interrupted migration.
An already migrated wave is verified without recopying or changing ownership.

If comparison finds a copy mismatch or a live source fails consistency checks, the function
reports an error and retains legacy ownership. Investigate the CloudWatch error
and migration report, fix the cause, then invoke again. If verification fails
after transfer, native ownership is retained: investigate the introduced difference rather
than blindly switching back and losing new native changes. Migration errors and
dropped continuations have regional alarms. Durable diagnostics remain in
`competition_migrations` and `competition_migration_audit`.

## Deployment

For an environment that has not received the original migration implementation:

1. Deploy `dbMigrationsLoop` to create the additive migration entities/views.
   Install capture using its migration-capture installation flag; remove the
   flag after installation. MySQL must allow these transactional triggers
   (`log_bin_trust_function_creators=1` where required). Never drop legacy history.
2. Deploy compatible consumers in order: `waveLeaderboardSnapshotterLoop`,
   `artCurationNftWatchLoop`, `tdhLoop`, `overRatesRevocationLoop`,
   `rateEventProcessingLoop`, `delegationsLoop`, `helpBotReplyLoop`,
   `waveDecisionExecutionLoop`, then `api`. Existing native claim/push consumers
   must also be compatible. Verify flags enable native writes and execution.
3. Deploy `competitionMigrationLoop` and its regional monitoring inventory/source
   relay after the function and log group exist.
4. Deploy the compatible frontend after backend health/version checks.

For this invocation simplification on an environment already running the original
implementation, deploy `api` first, then `competitionMigrationLoop`. The API must carry the
updated legacy configuration snapshot adapter before these sources transfer. There is no schema or
public API contract change, and existing checkpoint/audit rows are preserved.
A failure due to absent capture or disabled native runtime indicates an incomplete
backend deployment, not a missing operator approval.

Compatibility views are installed by `dbMigrationsLoop` under the `full` scope.
A projection fix must refresh those views before retrying a stopped migration.
For the sparse-rank and rank-badge corrections, deploy/invoke `dbMigrationsLoop`
with `full` scope first, then deploy `api`. Unvoted legacy submissions must not
acquire synthetic zero-score rank rows; an existing zero-score row or a later
native negative vote remains visible. The migration Lambda already reads these
views and supports rebuilding a failed shadow checkpoint, so its deployed retry
version does not need another deployment for this projection-only correction.

The inherited appearance correction requires `api`, then
`competitionMigrationLoop`. It adds presentation metadata to configuration
comparison and preserves supported appearance keys in new command snapshots.
Already migrated primaries with null `presentation_config` inherit their retained
wave metadata after the API deployment. Explicit native arrays, including `[]`,
override inheritance. No database refresh or frontend deployment is required.

The lower-level developer CLI remains available for diagnosis and explicit repair
or reverse reconciliation. Its historical acceptance commands are not prerequisites
for invoking the Lambda. A retry revalidates the source and retires prior legacy data-shape errors and
obsolete rollout restrictions before a fresh comparison. Native repair-required
states and explicit developer stops retain their protections.

If an independent comparison failed before cutover, invoking the same wave ID
again rebuilds the derived shadow stages and compares the complete data again.
This lets corrected copy logic repair an earlier checkpoint without editing the
database or bypassing a mismatch. Legacy text-backed vote totals are ranked
numerically, including negative totals and values with different digit counts.

Migration and reverse reconciliation compare complete histories, including waves
with more than 10,000 decisions or rows in a compatibility relation. The 10,000-row
limit applies only to optional shadow samples; it never truncates a migration
comparison or prevents an otherwise valid wave from transferring. This correction
requires deploying `competitionMigrationLoop`; no schema, API or frontend change
is needed.

Shared wave reply settings (`chat_replies_open` and `chat_replies_collapsed`)
remain wave-owned. Capture installation and health checks accept the exact current
trigger definition or the original v1 definition without those two columns.
Other schema or ownership-guard drift still fails.
Deploy `dbMigrationsLoop` with the `maintenance` scope, then `api`, then
`competitionMigrationLoop`. No trigger replacement, full schema sync, data update
or frontend deployment is required. Retry the same wave ID after deployment.

Historical decisions share each batch's row budget with their winners. Catch-up
rebuilds the captured decision keys, including moved and deleted keys, instead of
replaying the full unchanged history after every source update. Remaining derived
stages must finish before acknowledging their watermark, and the full independent
comparison still runs before transfer. This prevents recurring decisions from
continually restarting a large active wave's history. Deploy only
`competitionMigrationLoop` for this correction; existing checkpoints remain valid.

Deleted source drops may still have immutable decision winners and prizes.
Imported winners retain their original drop ID in `legacy_drop_id`; their history
survives without recreating the drop or a submission. Deploy `dbMigrationsLoop`
with full schema scope (additive column and compatibility view), then `api`, then
`competitionMigrationLoop` before retrying a comparison that found this case.

Existing positive time locks shorter than the current five-minute creation
minimum are retained during migration. The native weighted voting runtime already
supports these durations; the migration snapshot validator accepts them without
relaxing validation for newly created competitions.

The compatibility view preserves absent weighted leaderboard snapshots until
the native worker produces one. Deploy/invoke `dbMigrationsLoop` with `full` scope
before the migration Lambda to install this projection correction.

## Recovery qualification

**Main Stage remains on hold.** This section qualifies synthetic local recovery;
it does not authorize migration, staging, production, or production writes.
Independent verification in the original chat remains outstanding. This local
evidence is not a production-data rehearsal.

### Prerequisites and evidence

Use Node 22, `TZ=UTC`, Docker, both root and API dependencies installed through
the repository's `6529` wrapper, and an isolated Testcontainers MySQL database.
Do not copy a production `.env` or use a shared database for fault injection.
From the repository root:

```sh
./bin/6529 ci
(cd src/api-serverless && ../../bin/6529 ci)
TZ=UTC ./bin/6529 run test -- --runInBand \
  src/competitions/main-stage-recovery.integration.test.ts \
  src/competitions/competition-vote-activity.repository.test.ts \
  src/api-serverless/src/competitions/competition-vote-activity.service.test.ts \
  src/competitions/competition-migration.integration.test.ts \
  src/competitions/competition-migration-execution.integration.test.ts
```

The Main Stage-shaped fixture uses a **different, disposable wave ID**. It has
RANK, MAIN_STAGE, TDH whole-wave credit, negative votes, unsigned voting,
signed submissions, three active submissions per participant, 24-hour weighting,
and rolling 2/2/3-day decision gaps. The tests use real migration, API voting,
legacy voting, TDH reconciliation, reverse reconciliation, native execution,
outbox, effect receipts, claim service and repositories. Sockets, pushes,
announcements and the calendar response are local recording/failing sinks.
The claim service creates real rows in the disposable DB without media.
No AWS, production database, live claim publication or mint is exercised.

The recovery cases cover replacement votes (positive, negative and zero),
idempotency retries, compatibility double writes, an accepted vote between
reverse batches, a stale completed reverse snapshot, pending effects,
legacy voting immediately after rollback in the same second, another migration,
Activity identity/timestamp/content/proxy retention and stable pagination.
A conflicting Activity ID rolls back the complete vote transaction without
overwriting its existing log; re-migration retains history and allocates a fresh
sequence for the next accepted vote.
Activity also remains readable while a legacy-owned re-migration resets shadow
entries, using exact linked logs and the current legacy drop; that fallback never
exposes missing native entries or sibling COMPETITION drops.
A TDH reduction retains `-29 -> -3`, spending of `3` and its adjustment reason.
Repository/service tests also retain deleted historical references while hiding
native withdrawn/deleted entries, siblings and unreadable/private competitions.

### Supported rollback boundary

A return to LEGACY_ADAPTER requires no native decisions since cutover, no pending
native/legacy effects, no completed native publication effects, and no
native-created primary COMPETITION drops. Drain normal pending deliveries first.
Reverse reconciliation runs bounded batches under the normal ownership lock;
native writes can continue between batches. Only a final independent comparison
under that lock may switch ownership. If a later accepted write invalidates the
prepared snapshot, retain native ownership and repeat reverse reconciliation.

Use the developer CLI's `status`, `verify`, `reverse-reconcile` and `rollback`
actions against the explicitly selected environment and immutable primary UUID.
The CLI requires `COMPETITION_MIGRATION_ENVIRONMENT` to match `--environment`,
`NODE_ENV=local`, explicitly supplied reviewed DB settings and an operator in
`COMPETITION_MIGRATION_OPERATORS` for live actions. Local rehearsals additionally
require a loopback DB host. It never loads production secrets or synchronizes schema.
`reverse-reconcile` requires `--live --operator <allowlisted-profile> --reason
<incident-reason> --batch 1..100`; repeat until `reverse_ready` is true. Inspect
`rollback` without `--live` first, then execute the authorized rollback with the
same operator and reason only if its failures are empty. This document grants no
such authorization for Main Stage.

Never rewrite native COMPETITION drops to PARTICIPATORY, remove accepted votes,
history, decisions, winners or claims, flip ownership by SQL, or clear migration
checkpoints, outbox rows or effect receipts to make a guard pass. A reverse
refusal is a recovery boundary, not permission to weaken it.

### Demonstrated forward repair: failed publication delivery

For a post-cutover native submission/decision, keep native ownership. The tested
incident is a publication sink failure **after** the local claim transaction and
announcement receipt commit, before outbox acknowledgement:

1. Record the incident, immutable competition ID, deployed revisions, delivery
   error code and affected event IDs. Capture accepted entry/content identities,
   current and archived votes, history sequences, decisions/winners, claim
   provenance and publication receipts. Run `status` and `verify`; a guarded
   rollback reports `repairRequired` and retains NATIVE ownership.
2. Restore the failed delivery dependency or deploy a focused correction to its
   consumer. Preserve receipts and idempotency keys. In the qualification test,
   restore the local push sink; the claim consumer, decision data and receipts
   are unchanged. For a native-submission reverse refusal without decisions,
   record the owned exception with `record-exception`, then follow the same
   verification/review steps while retaining that submission.
3. Let the normal `waveDecisionExecutionLoop` run again after outbox backoff.
   Its real `CompetitionEventDispatcher.dispatchPending` retries existing
   events. Do not reset `next_attempt_at`, delivery leases, attempts or receipts.
   The CLI's `retry-effects` action retries **legacy** execution effects only;
   it does not drain the native outbox.
4. Wait for pending effects to reach zero. Compare the captured accepted data
   and inspect claim associations and durable effects. The test re-delivers the
   claim-routing request twice to the real local `MintingClaimsService`:
   one claim row/provenance association and one announcement/notification effect
   remain. Reprocessing native execution creates no second decision or winner.
5. Run `verify` again and require empty invariant failures, NATIVE/ACTIVE
   ownership, healthy capture/runtime flags and zero pending effects. Attach
   the independently reviewed evidence URL. Only then record `review-repair
--live --operator <allowlisted-profile> --reason <incident-reason> --evidence
<https-evidence-url>`. This appends NATIVE_REPAIR_REVIEW and returns migration
   state to NATIVE; native decisions/effects still prohibit rollback.

`reviewRepair` alone fixes no data or delivery dependency. It rejects pending
effects and invalid native invariants. The test calls it prematurely and asserts
that rejection. This procedure demonstrates delivery recovery and the supported
native-submission boundary; it is not a generic procedure for corrupted accepted
votes, content, winner choices or externally published mint data. Those require
incident-specific diagnosis and a separately reviewed forward correction.

### Rollout and remaining limits

For this correction on an already compatible environment, deploy affected native
vote/credit writers sequentially before permitting another migration:
`waveLeaderboardSnapshotterLoop`, `tdhLoop`, `overRatesRevocationLoop`,
`delegationsLoop`, `helpBotReplyLoop`,
`waveDecisionExecutionLoop`, then `api`, then `competitionMigrationLoop`.
These are the deployed entry points for the changed native runtime, TDH/REP
revocation and voting paths; the migration Lambda marks exact-identity cutovers.
Verify versions/health after each. No entity, schema sync,
OpenAPI or frontend build is required. The frontend already calls native voting
when entry context exists and renders the unchanged Activity response contract;
its native-competition sandbox and social read-only Activity scenarios remain
applicable. No deployment is performed by the Phase 2 qualification task.

The exact recovery reader is enabled only when **every** recorded CUTOVER for
that primary certifies `voteActivityIdentity=NATIVE_ID_V1`, with at least one
cutover. Deploy all writers before the migration Lambda and before Main Stage's
first cutover. This ordering is a prerequisite for that certificate's validity.
Rollback audits do not remove qualification; a mixed old/new cutover history does
not automatically qualify. The reader uses exact native log IDs, never inferred
ownership intervals, to deduplicate all retained legacy logs across recovery.

For earlier or unmarked migrations, keep the established read paths: native
ownership combines native history with logs up to the transfer timestamp;
LEGACY_ADAPTER reads wave logs. This patch does not qualify exact recovery of
those older histories. Old random compatibility IDs have no shared event identity,
and transition seconds can be ambiguous. Do not infer provenance by matching vote
values/timestamps, retroactively mark old cutovers, or enable the full recovery
reader without a separate historical data review. No old records are rewritten
and no missing provenance is manufactured. This limitation applies to previously
migrated competitions; Main Stage's independent hold remains in effect.

Offset pagination is deterministic for a fixed history; concurrent new votes can
shift offsets, as with the existing API. A production-sized query/latency rehearsal,
production Main Stage data parity, real queue redelivery, media/claim publication,
Arweave and on-chain minting remain outside this synthetic evidence. Keep the
independent Main Stage hold until that verification is complete.
