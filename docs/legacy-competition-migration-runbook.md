# One-at-a-time legacy competition migration

Roadmap Phase 5 adds migration tooling; delivery Phase 2 ends at reviewed PRs
and passing checks. It does not authorize deployment or a production migration.
Use this runbook only after the appropriate environment release is authorized.
The original primary UUID remains immutable. UI default selection never changes
ownership, migration targets, capability assignment or an already selected vote.

## Current acceptance ledger

| Gate                                                                       | Current evidence                                                                                   | Execution owner                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Native production Rank and Approve completion with correct effects         | Pending; staging fixtures and production read-only checks do not establish this                    | Named backend/operations operator required before enrollment |
| GET p95/error baseline, current values and reviewed budgets                | Pending production measurements                                                                    | Named operations operator required                           |
| Decision lag p95/p99 and approved budgets                                  | Pending production measurements                                                                    | Named operations operator required                           |
| Backlog, oldest-pending, duplicate-effect/claim and capture-failure alerts | Pending verification links and thresholds                                                          | Named operations operator required                           |
| Compatible API, decision, leaderboard and TDH runtime revisions            | Must be recorded from deployed versions for the target environment                                 | Release operator                                             |
| Cohort incident window, rollback rehearsal and old-client acceptance       | Pending per-cohort review                                                                          | Migration operator recorded by enrollment                    |
| Independent parity                                                         | Collected separately for each enrolled UUID; seven consecutive full zero-mismatch windows required | Migration operator                                           |

These are pending gates, not evidence of a production failure. Do not substitute
local test URLs, guessed metrics, a deploy success or an adapter comparing with
itself for reviewed production evidence. `readiness` and `cutover` enforce the
ledger. No command waives an owned exception.

## Additive rollout with continuous service

Deploy each backend service sequentially and verify success before its dependents.
No schema, queue, mapping or history is removed. Do not enroll a competition
while old writer/worker versions remain in service.

1. Deploy `dbMigrationsLoop`. Perform its authorized manual full invocation to
   synchronize additive migration journal/audit/checkpoint, transactional mirror
   permit and legacy publication-receipt entities, nullable pause source ID and
   leaderboard ordering fields. The same invocation installs the 12 permanent
   GET views. Set `COMPETITION_MIGRATION_CAPTURE_ENABLED=true` for the reviewed
   schema invocation to install 69 triggers across 23 source/content tables.
   Repeat installation and inspect schema health; scheduled invocations do not
   install DDL. Schema deployment itself enrolls nothing. Capture installation
   requires the database TRIGGER privilege and the reviewed RDS parameter
   `log_bin_trust_function_creators=1` when binary logging requires it. DDL uses
   a five-second metadata-lock timeout and fails for safe retry under contention;
   each additive statement commits independently. Verify entity synchronization
   on the target schema before the maintenance window.
2. Deploy `waveLeaderboardSnapshotterLoop`, `tdhLoop`,
   `overRatesRevocationLoop`, `rateEventProcessingLoop`, `delegationsLoop` and
   `helpBotReplyLoop` (also packages `helpBotDailyActivityCreditLoop`) and
   `newsletterLoop` (production only) for shared owner-aware voting, maintenance,
   identity-consolidation and read code. Verify the compatible native message
   consumers from the prior runtime release (`claimsBuilder` and
   `pushNotificationsHandler`) are already deployed; this change adds no message
   shape and does not require redeploying those consumers.
3. Deploy `waveDecisionExecutionLoop` for transaction ownership checks,
   retryable legacy publication receipts and native transferred-history execution.
4. Deploy `api` for the permanent GET facade and old mutation dispatch. Verify
   deployed SHAs, health, old GET contracts and native commands. Keep native
   writes/execution enabled consistently wherever a migrated owner will run;
   disabling those flags is a deliberate activity stop, not a storage rollback.
5. Only after backend success merge/deploy the frontend compatibility change.
   Require the related desktop/mobile E2E before further promotion.
6. Collect and review the pending evidence above. Then authorize a separate
   one-competition rehearsal/pilot. Main Stage stays legacy until its dedicated
   privileged release review and adapter work are complete.

Confirm service names against `src/config/deploy-services.json`. Shared schema
and SQL-executor code is bundled by backend services: upgrade any additional
source writer identified in the environment inventory before enrollment. Retain
all capture triggers, GET views and receipt tables while any migrated owner
exists. Reverting to an API/worker version without ownership fences is unsafe.

## Configure an explicit operator environment

The CLI is `./bin/6529 run competition:migrate -- --help` from the backend root.
It never loads cloud secrets or synchronizes schema. Supply approved write/read
DB configuration through the normal environment. Keep credentials out of shell
history and output. Configure `NODE_ENV=local` even for an operator connecting
through an approved staging/production tunnel; this prevents automatic cloud
secret loading. `COMPETITION_MIGRATION_ENVIRONMENT` must exactly equal the
`--environment` argument. A `local` target additionally requires a loopback DB.
Live commands require the named profile in `COMPETITION_MIGRATION_OPERATORS`.

Obtain the existing `legacy_primary_competition_id` from the authorized hub
read. Copy that exact UUID and verify it with `status`. A wave ID, native-only
competition UUID, `all`, creation date or navigation default is not a target.

For the examples below, set only these non-secret task variables:

```sh
migration_environment=local
migration_competition='<exact existing legacy competition UUID>'
migration_operator='<allowlisted operator profile ID>'
migration_reason='<reviewed cohort / incident reference>'
```

Replace placeholders before execution; the CLI rejects them. Every invocation
names one UUID. Omitting `--live` leaves the operation read-only; for enroll,
backfill, catch-up, comparison and record actions this reports current status
without rehearsing a mutation. Cutover/rollback dry runs evaluate their gates.

## Rehearse and migrate one competition

1. Inspect without mutation:

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action status
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action readiness
   ```

2. After enrollment is separately authorized, choose the reviewed cohort:

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action enroll \
     --cohort COMPLETED_INTERNAL --operator "$migration_operator" \
     --reason "$migration_reason" --live
   ```

   Cohort order is completed internal, completed ordinary, active low volume,
   complex, then privileged/Main Stage. An active transfer requires an earlier
   completed native migration. Privileged, complex, active negative-vote, active negative-credit, signed-vote, unsupported
   rule and high-volume sources receive owned stops. Main Stage also has an
   explicit final release-review stop. These stops require reviewed adapter
   development and renewed full evidence; no exception-clearing CLI is provided.

3. Run **one bounded batch per invocation**, inspecting the returned checkpoint:

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action backfill --batch 25 \
     --operator "$migration_operator" --reason "$migration_reason" --live
   ```

   Repeat until `state=SHADOWING`. Stage order is configuration, outcomes,
   entries/content, pauses, decisions, voters, runtime votes, leaderboard,
   winner awards/history, archived voters. Most stages use stable keyset cursors;
   one decision/winner is one bounded unit. Ordinary outcome/distribution and
   winner/award fanout is capped at 100. Full content comparison caps ordinary
   cohorts at 1,000 entries; relational comparison refuses truncated coverage.
   Larger shapes stop for an owned adapter. Transactions checkpoint atomically,
   are idempotent and have a durable minimum 250 ms interval between batches.
   Reduce batch size or pause invocations if live traffic approaches its budget.

4. Catch concurrent writes through the journal:

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action catch-up --batch 25 \
     --operator "$migration_operator" --reason "$migration_reason" --live
   ```

   Repeat while journal lag remains. A fully drained journal starts a bounded
   derived-data refresh (`BACKFILLING`); finish it with the backfill command.
   Only after refresh does `applied_watermark` reach its target. Reinspect until
   source/applied watermarks match. A journal gap is a hard stop. Accepted writes
   journal in their own transaction, including deletions, voter rekeys and eight
   child-content tables; rolled-back writes create no capture records.

5. Prepare an acceptance JSON using
   [the pending template](./legacy-competition-migration-acceptance.pending.json).
   It deliberately contains null evidence/metrics and is **not a valid acceptance
   record** until every field has real reviewed evidence. Record six HTTPS
   evidence links, the recording operator and timestamp, full-window duration,
   four deployed service SHAs, measurements/budgets and incident-window bounds.
   All durations/timestamps use milliseconds; error rates are fractions 0..1.
   The attestation expires after 24 hours.

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action record-acceptance \
     --acceptance '<reviewed acceptance JSON path>' \
     --operator "$migration_operator" --reason "$migration_reason" --live
   ```

6. Run independent comparisons at the approved cadence:

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action compare --window 60000 \
     --operator "$migration_operator" --reason "$migration_reason" --live
   ```

   Use the actual approved duration, at least 60,000 ms. The first sample opens
   a window; a later full sample closes it. Observe every window boundary without
   exceeding the window-duration sample gap. A partial sample never increments
   the streak. Mismatch, missing coverage, source credit overspend, catch-up lag,
   duration change or a gap resets it. Require seven consecutive full windows.
   Source reads use direct legacy SQL; candidates use native tables/content and
   all 12 frozen facade relations in one consistent locked snapshot. Reports
   retain hashes/counts, not private content or signatures. Full comparisons can
   hold the owner lock longer than a batch; approve their cost on a representative
   copy before live use and measure actual request/decision latency.

7. Re-run `readiness`, then a dry-run cutover with the same UUID/operator/reason.
   Require `failures=[]`. A comparison must be fresh within 60 seconds, at the
   current source watermark, with zero pending native or legacy effects. Retry
   unfinished legacy publication receipts with `--action retry-effects --live`
   only in the authorized environment; stable claim/push IDs survive retries.

   ```sh
   ./bin/6529 run competition:migrate -- --environment "$migration_environment" \
     --competition "$migration_competition" --action cutover \
     --operator "$migration_operator" --reason "$migration_reason"
   ```

   Add `--live` only for the authorized transfer. The command locks the same
   competition row as APIs/workers, performs a final full independent comparison
   through its committed watermark, then transfers storage/execution atomically.
   Legacy discovery is advisory; legacy execution rechecks owner in its actual
   transaction. The immutable primary and drop deep links do not change.

8. Run `--action verify` and `status`. Require native ownership and no invariant
   failures. Check frozen old GETs, scoped new reads, supported old submissions,
   edits/deletion/voting/settings/pauses, chat and native-only competition
   isolation. Monitor latency/error/decision lag, source/applied lag, per-category
   hashes, effect backlog/age/attempts and duplicate receipts. Record evidence
   before selecting another UUID. Audit reports and durations live in
   `competition_migration_audit`; restricted capture images must not be exported.

## Rollback and repair

Before any new native decision or external effect, run `rollback` without
`--live` to inspect safety. It will require actual reverse reconciliation:

```sh
./bin/6529 run competition:migrate -- --environment "$migration_environment" \
  --competition "$migration_competition" --action reverse-reconcile --batch 25 \
  --operator "$migration_operator" --reason "$migration_reason" --live
```

Repeat bounded batches until `reverse_ready=true`. Native ownership remains
active throughout preparation. Dry-run rollback then performs full independent
comparison against the reconciled legacy state; intervening writes can require
another pass. Add `--live` for an authorized atomic rollback. Do not flip storage
with SQL. Re-enrollment resets native shadow data in bounded batches, clears old
acceptance and requires seven fresh windows.

After a native decision, pending publication or completed external effect, live
rollback refuses transfer and records `ROLLBACK_REQUIRED`. Keep native ownership,
inspect durable receipts/claim provenance and complete an owned repair using
reviewed incident evidence. `review-repair --evidence <HTTPS record> --live`
records that reviewed repair only after pending effects drain and native aggregate
and orphan checks pass. It does not repair data or undo a claim/announcement.
Ownership stays native and blind rollback remains guarded.

For a new discovered source limitation, `record-exception --exception <CODE>
--live` records a stable uppercase code with the operator and resets parity.
The CLI also records `MIGRATION_DATA_SHAPE` after an owned shape failure. Preserve
history, receipts and journal checkpoints; resolve through reviewed code and
rehearsal, never by deleting the guard or fabricating acceptance.

## Operator status and alert evidence

`status` is the per-UUID operational view: durable stage/cursor/rate limit,
source/applied/target watermarks, journal lag, window streak, owned exceptions,
publication backlog/retries/oldest pending timestamp and the ten most recent
audited reports (including batch duration and category parity hashes/counts).
Use these bounded records in the reviewed monitoring collector. Alert integration,
request latency/error segmentation and decision p95/p99 are external production
evidence gates; the CLI does not invent measurements or claim alerts are installed.

## Tested boundaries

Disposable MySQL tests exercise repeated schema installation, transactionally
captured/rolled-back writes, bounded restart/catch-up, content-only edits, voter
rekeys, independent mismatches and seven-window resets, migrated Rank/Approve
execution, weighted histories and pauses, old vote retries, pending legacy
publication leases, permanent native-backed reads, reverse reconciliation,
atomic rollback and guarded post-decision refusal. Frontend unit and desktop/mobile
sandbox tests exercise scoped submission rendering from frozen CHAT responses.
These are implementation tests, not production migration or SLO evidence.
