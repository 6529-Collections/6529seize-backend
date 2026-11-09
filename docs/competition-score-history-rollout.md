# Competition score history rollout

Leaderboard refreshes read only AGGREGATE history. Winner and curation execution
still read AGGREGATE and VOTER history. Both paths join active entries before the
history sort through the existing competition/entry index. Scoring, reset
cutoffs, independent imported streams, time weighting and tie order are unchanged.

`competition_score_resets` has one indexed row per reset submission. Revision,
event creation time and event ID choose the latest reset in exactly that order.
`competition_score_reset_state` records the copy cursor, completion and cutover.
Full-content update events and their projection are written atomically from the
stored event; presentation updates do not change the projection.

## Deployment order, in each authorized environment

Use ordinary merges and `Deploy a service`, as described in [deployment](deployment.md).
Resolve any current TDH release dependency before redeploying TDH/delegation code.

1. Deploy `dbMigrationsLoop` with `db_schema_scope=competition-score-resets`.
   The entity scope adds only the two tables; it runs no unrelated schema sync,
   historical migrations or data copy. Verify both tables exist.
2. Deploy `api`, the full-content reset writer. Wait for the deployment health
   checks and for invocations of its previous version to drain before copying.
3. Deploy affected shared-code readers sequentially: `waveLeaderboardSnapshotterLoop`,
   `waveDecisionExecutionLoop`, `artCurationNftWatchLoop`, `overRatesRevocationLoop`,
   `helpBotReplyLoop`, `delegationsLoop`. Verify each service before
   starting the next. Existing dependencies must already be healthy; they do not
   require redeployment just for this change.
4. Invoke the operator scope below, in batches, until `backfill_complete=true`.
5. Run `compare` for representative busy and reset competitions. It must return
   `equal=true`; compare full history against the event lookup and total history
   against the filtered reference in the same transaction snapshot. Optional
   `explain=true` returns actual plans. The legacy-reset comparison already uses
   the active-entry-first join, so its timing isolates the reset lookup cost.
6. Invoke `enable`. Check status, API health, leaderboard/decision execution and
   new query plans. Deploy `tdhLoop` last, after cutover verification, with the
   final production publication signal. The previous TDH version can keep using
   the original event reader during this sequence. Validate related staging E2E
   before production promotion.

Use the same reviewed commit across the environment's sequential deployments;
supply `expected_source_sha`. Preserve the normal production release-note group
and publish only after its last successful service.

## Operator invocations

Invoke the deployed `dbMigrationsLoop` with the environment's region and normal
AWS credentials. Use a read timeout longer than the Lambda timeout. Inspect the
response body for `FunctionError` as well as the invoke response status.

```json
{"schema_scope":"competition-score-resets-backfill","action":"status"}
{"schema_scope":"competition-score-resets-backfill","action":"backfill","writers_deployed":true,"limit":10}
{"schema_scope":"competition-score-resets-backfill","action":"compare","competition_id":"<uuid>","explain":true}
{"schema_scope":"competition-score-resets-backfill","action":"enable","writers_deployed":true}
{"schema_scope":"competition-score-resets-backfill","action":"disable"}
```

`writers_deployed=true` is an operator assertion, not automatic version discovery.
Verify the API deployment before supplying it. The scope is never run by a
schedule or ordinary deploy invocation. Its default is read-only status.

Each backfill transaction locks the progress row, then one competition, copies
and verifies its latest resets, and commits the cursor. READ COMMITTED ensures
verification sees edits committed while acquiring the competition lock. A crash
rolls back that competition; repeat the same invocation to resume. The upsert
never replaces a newer live reset with an older event. New competitions are
covered by the upgraded writer, including IDs behind the copy cursor. Readers
cannot be enabled until the scan is complete. Do not run the copy while reads
are enabled. Keep the original events throughout rollout and rollback.

## Rollback

Disable projected reads first; this also clears backfill completion and its cursor. Existing application versions continue using the
original events and ignore the new tables. After disabling, application rollback
does not require a schema rollback. If an old reset writer is redeployed, keep
projected reads disabled: before re-enabling, repeat the full copy
under the same operator process so resets produced by that old writer are not
missed. Never simply re-enable a previously completed projection after old writers
have run. Do not delete the outbox or drop either table during application rollback.

`EXPLAIN ANALYZE` requires MySQL 8.0.18+ and executes each SELECT again.
Start comparisons without `explain`; collect plans for one representative
competition at a time outside peak load.

The read-mode check deliberately stays an uncached primary-key SELECT. Product
loads already own either the competition lock or a repeatable-read snapshot;
standalone history calls open their own snapshot. Disabling does not remove any
projection rows. Event and projection writes commit together, so in-flight reads
can finish safely and subsequent loads immediately observe the rollback flag.

Writers and backfill both lock the competition before any projection row. Only
backfill locks progress; writers never request that lock, so it introduces no
reverse dependency. A missing projected row after verified cutover means no reset,
which is common; querying the outbox for every such absence would restore the
original hot-path event scan.
