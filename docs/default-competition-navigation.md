# Default competition read boundary

Status: implemented on a development branch; delivery Phase 2 review and CI
pending. Not merged or deployed.

`GET /v3/waves/{wave_id}/default-competition` returns a nullable
`competition_id`, server `evaluated_at` and nullable `next_refresh_at` in UTC
milliseconds. Unified reads must be enabled. The existing wave and parent-wave
visibility checks run before selection; participation/voting groups do not
restrict readable competitions. An unreadable or missing wave is masked as 404.
The server selects across every record, independently of collection pages,
filters, draft administration and client clocks.

## Selection normalization

- Legacy records use the current wave's participation/voting dates and decision
  schedule, not stale copied competition columns. Their frozen GET projections,
  immutable primary mapping, executor and capabilities remain unchanged.
- Native records require publication. Drafts, never-published archived drafts,
  cancellation-only records and cancelled lifecycle are excluded. Archived
  history requires completion evidence.
- Effective start is the earlier participation/voting start. A null start is
  unbounded and sorts before dated starts; creation/publication is not a proxy.
- A null end keeps that period open. Both finite periods must close. Legacy
  ends are exclusive; native ends are inclusive, matching their command checks.
- A started contest with pending decisions remains active even after both
  periods close, including pauses. Native Approve remains active until its
  runtime records completion. Legacy Approve remains active while its winner
  quota is unfulfilled (including an unlimited quota), matching the legacy
  decision worker; a satisfied quota completes it.
- Native completion uses recorded `ended_at`, with finite period closure as a
  fallback when no decision is pending. Legacy Rank end is the later of the
  closed periods and last decision. Legacy Approve quota completion uses its
  last decision. An explicitly ended record with no known end sorts after
  history with known ends. Archive, update and cancellation times never rank
  completed history.
- Selection order is active, upcoming, completed. Active/upcoming sort by
  ascending effective start; completed by descending end. Equal times use
  ascending immutable ID with bytewise string comparison. Zero candidates
  returns null. A pause does not alter age or activate an upcoming contest.

`next_refresh_at` is the next future start or period-close boundary. Native
closure uses end + 1 ms. Lifecycle/decision changes also require invalidation
or bounded polling; this timestamp is not a promise of unchanged selection.

## Query cost and rollout

The unpaginated competition projection uses the existing wave-leading indexes
and reads only selection columns, without hydrating entries, votes, outcomes,
capabilities or pauses. Legacy waves additionally aggregate count and latest
decision. The additive `idx_wave_decisions_wave_time (wave_id, decision_time)`
is a covering index for that per-wave query; its previous primary key leads
with decision time. The migration uses `ALGORITHM=INPLACE, LOCK=NONE`, propagates
DDL failures, tolerates an already-existing index and retains it on rollback.
Entity synchronization does not create or remove this operator-managed index.
Selection costs scale with competitions and decisions in one readable wave,
not all waves or each hydrated competition. MySQL integration coverage checks
the real migration, aggregation, repeat application and covering EXPLAIN plan.

Future staging and production order:

1. Deploy `dbMigrationsLoop` and run the migration;
   verify `idx_wave_decisions_wave_time` exists before API traffic uses it.
2. Deploy `api` (`seizeAPI`); verify the additive endpoint and legacy GET parity.
3. Only then merge/deploy the dependent frontend in that environment and run
   the competition desktop/mobile E2E pack.

No execution worker, consumer or data cutover changes are required. Existing
clients tolerate the index and endpoint. Roll back frontend navigation first;
the old API remains compatible and the index can stay. API rollback must not
precede frontend rollback while the dependent UI is enabled.
