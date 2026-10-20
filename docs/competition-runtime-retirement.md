# Competition application/runtime retirement

This release retires application execution and storage dependencies. It does not
authorize physical table/column deletion, orphan cleanup, migration Lambda/IAM/
alarm deletion, production deployment, or media/CDN changes. All existing schema
entities remain registered so TypeORM cannot silently remove retained columns.

## Permanent behavior

Every functioning competition uses competition-scoped configuration, entries,
votes, independent score histories, decisions and awards. Old unversioned/v2
wave/drop GETs remain explicit native projections of the immutable original
primary. Default navigation never repoints them and siblings never enter their
old competition data. Shared chat, profiles, appearance inheritance, claims,
notifications, MAIN_STAGE/CURATION/QUORUM, signatures and proxy attribution remain.
New hubs always create CHAT waves. Existing RANK/APPROVE physical types remain
updatable and their wire classifications come from the compatibility views.

Shared hubs retain their accepted participation and voting settings in typed
`hub_participation_config` and `hub_voting_config` on the existing wave domain.
Current creation, editing and GETs use that configuration, including independent
nullable scopes, credit settings, periods, terms and required content. Existing
wave archive rows retain the corresponding configuration snapshots. Original
competition projections continue to use their immutable native competition.

AGGREGATE and VOTER history observations retain their independent source IDs,
times and values, including historical inconsistencies. No timestamp pairing or
current-vote reconstruction is permitted. Rolling writers attach the accepted
native mutation sequence to observations so same-millisecond ordering remains
correct without changing original public history IDs. Shared Activity keeps
exact IDs/contents/proxy/time; exact-ID deduplication occurs before pagination.
Entry revisions keep complete history and delimit live scoring through native
update events. Native outbox/effect/delivery receipts remain the replay boundary.
Presentation-only revisions retain content history without resetting weighted
voting observations. Independent curation transfers at the same timestamp keep
separate accepted winners/effects and their original rank-one results; the winner
rank index is nonunique while decision/entry identity remains unique.

## Compatible staging sequence

Use ordinary merges and the existing `Deploy a service` workflow. Inspect current
runs and shared refs before every staging merge; preserve other developers' work.
The reviewed backend change contains a preparatory revision followed by final
retirement. Deploy that preparation before switching any reader.

1. Merge the reviewed preparation into latest `1a-staging`. Deploy
   `dbMigrationsLoop` with `db_schema_scope=full` to add native score-history,
   shared Activity scope and native history attribution fields. Old entities,
   readers, views and mirrors remain compatible.
2. Deploy the inert `competitionMigrationLoop` transition artifact. Its reserved
   concurrency is zero, so unqualified and qualified old versions cannot accept
   new work. Verify the code/version/configuration and absence of a running
   migration. Queued continuations expire/are acknowledged inertly; no migration
   copy/reverse path is reachable. Keep its physical resources and monitoring.
3. Sequentially deploy each writer affected by the native history helper:
   `artCurationNftWatchLoop`, `waveLeaderboardSnapshotterLoop`, `tdhLoop`, `overRatesRevocationLoop`,
   `helpBotReplyLoop`, `waveDecisionExecutionLoop`, then `api`. Confirm any other
   live writer discovered in the change's call inventory before continuing.
   Preparation writes the exact source-stream IDs into native score history
   while retaining old readers and mirrors. Profile consolidation updates both.
   Prepared revocation discovery and curation watches must already read native
   configuration, entries and voters for native owners, including siblings, while
   retaining preparation mirrors. An owner lock cannot repair a stale discovery
   query that returns before acquiring it. Only actual legacy owners may use the
   retained preparation branches.
   Original settings and pause commands already use native authority during this
   preparation; stale physical mirrors cannot overwrite progressed decisions or
   native pauses. Submission edits preserve both raw history streams and record
   explicit per-stream/native reset watermarks in the existing update event.
   Prepared historical GETs use compatibility views that initially pass through
   retained source histories. The explicit final switch replaces those same
   views with native history, so an in-flight prepared API cannot keep reading
   stale source observations after native workers stop mirroring.
4. Wait for old writer invocations to drain. Use observed invocation/concurrency
   evidence and each unit's configured timeout; a successful deployment alone
   does not prove old execution has finished. Invoke `dbMigrationsLoop` with
   `schema_scope=competition-history-preparation`. The repeatable transfer locks
   native ownership for one bounded keyset batch at a time, releases the lock
   between batches, retains independent source observations, scopes accepted
   shared Activity and seeds only missing delivered native receipts for already
   emitted historical transitions. Existing pending native effects stay pending.
   Preserve parentless historical distribution children in the existing native
   distribution relation with their scoped outcome and child indexes, without
   creating a visible outcome parent. Recheck exact counts/nulls/values before
   switching their permanent GET projection. Compare source/target counts and
   exact fields for both score streams. A mismatch is
   a failure; never reconstruct or discard rows to satisfy it.
   Retain published weighted snapshots for drops without a native entry in the
   existing native leaderboard relation, including decision-time scores, ordering
   times and nullable approval thresholds. These rows create no memberships and
   are excluded from native voting, ranking, decisions, claims and listings.
5. Merge final retirement into current `1a-staging`. Deploy `dbMigrationsLoop`
   with `db_schema_scope=competition-runtime-schema`: synchronize the retained
   registry/additive final columns without replacing views prematurely. Invoke
   `wave-hub-configuration-preparation` next. It installs narrowly named
   temporary captures for wave/archive and credit-NFT writes, transfers accepted hub
   configuration in bounded batches and requires exact parity. Captures keep
   prepared API writes current during the remaining rolling deployment and retain
   explicit native configuration writes, including the old API readers' optional-field
   preservation during overlap. Report only field names and counts for
   failed parity; keep hub identities and setting values out of workflow logs.
   Then invoke the explicit `competition-runtime-retirement` scope. It requires all
   live original primaries to be native and the old execution-effect queue empty,
   rechecks history and hub-configuration parity, preserves weighted snapshot publication, disables only
   the frozen old capture triggers and installs explicit native-only views.
   Ordinary full/scheduled schema work never performs this transfer or retirement.
   Ordinary full sync can maintain an already native facade but cannot perform
   its initial switch. Completion requires every compatibility view to use native
   dependencies; a partial installation is retried before deploying native-only
   writers. Once all views have switched, retirement retries maintain those views
   without reimporting stale physical data, and history-preparation is rejected.
   Retained source rows cannot overwrite existing native observations on conflict.
6. Deploy changed consumers/workers sequentially: `claimsBuilder`,
   `newsletterLoop`, `waveDropMetricsRefreshLoop`, `artCurationNftWatchLoop`,
   `tdhLoop`, `overRatesRevocationLoop`, `helpBotReplyLoop`,
   `waveLeaderboardSnapshotterLoop`, `waveDecisionExecutionLoop`, then `api`.
   Drain each replaced old reader before a subsequent writer stops mirroring;
   verify configured timeouts and observed running invocations. Keep message
   consumers before their producers; verify already-deployed compatible unchanged
   notification consumers rather than redeploying unrelated units. `newsletterLoop`
   is production-only in the service catalog: validate its changes locally and
   reserve its deployment for a separately authorized production release. Do not
   dispatch it to staging or broaden its allowed environments. Check exact
   dependencies and permitted environments against `src/config/deploy-services.json`
   and the final call graph. The prepared API's native-authoritative mutation path
   is essential throughout this rolling overlap.
7. After the final API's build, artifact, exact version and health checks pass,
   wait for every replaced prepared API invocation to drain using the previous
   configured timeout and observed execution evidence. Invoke
   `wave-hub-configuration-finalize` to disable the temporary hub captures.
   Require complete native views and valid current native hub configuration;
   retries must never reimport obsolete settings after the native switch. The
   completed application operates with these captures disabled and the obsolete
   physical columns absent in disposable acceptance tests.
8. Only after backend build/artifact/version/health verification, merge frontend
   into current staging. Wait for `Web Deploy - STAGING` success and verify current
   original-primary plus native sibling flows, special capabilities, creation,
   voting/My Votes, leaderboards/winners and administration. This retirement's
   Phase 3 acceptance additionally requires GREEN relevant staging E2E. Unrelated
   E2E failures are reported separately and do not authorize unrelated fixes.

The isolated monitor retains the migrator in
`ops/monitoring/retained-producers.json`, independently of ordinary deploy choices.
Generator verification must keep its existing monitoring infrastructure unchanged;
no monitoring deployment or resource deletion is part of this retirement.

The final service catalog excludes the retired migrator. Its inert source and
physical configuration remain recoverable until the separate infrastructure
chunk. Never invoke an old migration/reverse command or restore rollout flags as
rollback. The source retirement cannot itself delete old tables or columns.

## Validation and rollback boundary

The immutable Phase 0 OpenAPI/runtime-route fixtures remain unchanged. Native
history parity tests cover independent contradictory streams, same-time ordering,
repeat transfer, Activity attribution/pagination and historical transition
receipts. Disposable MySQL acceptance physically removes obsolete tables and wave
columns, then verifies public projections, voting/history/activity and idempotent
decisions. This destructive fixture is restricted to automatically discarded Jest
databases; it is never an operator cleanup command.

Preparation is additive and compatible with old readers. After native-only writes
begin, returning to an old reader/mirror build requires an explicit compatibility
review; old physical tables no longer receive current writes. Roll back through a
compatible reviewed source while preserving native ownership, score history,
command/signature receipts and accepted effects. Do not replay starts, transitions,
claims, awards, announcements or notifications. Diagnose a failed service and fix
on the development branch, then merge forward and redeploy in dependency order.
