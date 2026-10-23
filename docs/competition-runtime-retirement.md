# Competition runtime after retirement

Every functioning competition uses the native runtime. One-time transfer,
reconciliation, capture and rollout commands have been removed. For intentional
physical storage and dedicated infrastructure deletion, follow the
[final cleanup procedure](competition-storage-cleanup.md).

## Permanent behavior

Every functioning competition uses competition-scoped configuration, entries,
votes, independent score histories, decisions and awards. Old unversioned/v2
wave/drop GETs remain explicit native projections of the immutable original
primary. Default navigation never repoints them and siblings never enter their
old competition data. Shared chat, profiles, appearance inheritance, claims,
notifications, MAIN_STAGE/CURATION/QUORUM, signatures and proxy attribution remain.
New hubs always create CHAT waves. Historical RANK/APPROVE wire classifications come from the compatibility
views; shared wave storage no longer owns a competition type.

Shared hubs retain their accepted participation and voting settings in typed
`hub_participation_config` and `hub_voting_config` on the existing wave domain.
Current creation, editing and GETs use that configuration, including independent
nullable scopes, credit settings, periods, terms and required content. Existing
wave archive rows retain the corresponding configuration snapshots. Original
competition projections continue to use their immutable native competition.
The voting policy also owns the existing typed `decision_strategy` metadata exposed
by shared-hub GETs. Current edits can explicitly clear it; CHAT writes still reject
new non-null strategies, and this metadata never enables competition execution.

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

## Schema maintenance

`dbMigrationsLoop` maintains the fourteen explicit native-backed compatibility
views during manual `maintenance` and ordinary full schema work. Scheduled
maintenance does not run DDL. No path transfers old histories or reinstalls
capture triggers.

Old table entities and obsolete wave/competition column decorators are absent.
Full synchronization first rejects any remaining retired columns, so TypeORM
cannot silently choose the destructive boundary. Use `maintenance` during
rolling deployment, intentionally remove the reviewed storage after backup and
old-invocation drain, then verify `full` succeeds without recreating it. Fresh
schemas synchronize the current entities and install the permanent views.

Historical applied migration ledger entries remain. Removed migrations only
targeted retired storage; they are not rerun by deployment. Current entity
bootstrap and already-applied live migration history are separate checks.
Rollback after deletion requires compatible native code or an isolated restore
and selective repair; old transfer or mirrored-storage binaries are unsafe.
