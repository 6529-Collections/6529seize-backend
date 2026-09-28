# Competition Read Boundary Runbook

The Phase 1 competition foundation is additive. Existing unversioned and v2
wave/drop GET routes remain the authoritative public behavior, and legacy wave,
drop, vote, decision, and outcome writes remain authoritative.

## Safe Defaults

Leave all of these controls absent or false unless a rollout explicitly changes
them:

- `FEATURE_UNIFIED_COMPETITION_READS`
- `FEATURE_NATIVE_COMPETITION_WRITES`
- `FEATURE_NATIVE_COMPETITION_EXECUTION`
- `FEATURE_NATIVE_COMPETITION_HUB_CREATION`
- `FEATURE_LEGACY_COMPETITION_SHADOW_COMPARE`

`COMPETITION_LEGACY_SHADOW_SAMPLE_RATE` defaults to `0` and accepts only a
finite value from `0` through `1`. Enabling the shadow flag without setting a
positive valid rate therefore performs no comparisons.

Native writes, native execution, and native hub creation are not Phase 1
rollout controls: they must stay disabled. Storage and execution ownership are
read from the competition routing record by both APIs and workers. A native
competition is never worker-owned unless its record is `ACTIVE` and the native
execution feature is also enabled.

## Deployment and Verification

Deploy in this order:

1. `dbMigrationsLoop`, which creates the additive tables and idempotently
   establishes the immutable legacy mappings.
2. Workers that consult competition routing, while native execution remains
   disabled.
3. The API, while unified reads and shadow comparison remain disabled.
4. A sampled shadow-read rollout only after the schema and API are healthy.

Verify that the migration Lambda completes, repeated backfill reports no new
mappings, every non-chat wave has exactly one `legacy_wave_id` mapping, and chat
waves have none. Confirm existing wave, drop, vote, leaderboard, decision, and
outcome health before increasing a shadow sample.

Parity observations contain only route identifiers, comparison categories, and
canonical hashes. Query mismatches by `category`, `competition_id`, and
`observed_at`; do not add signed payloads, vote payloads, or user content to
parity logs.

## Independent Legacy Read Samples

The current sample source is `legacy-read-v2:<revision>`. Earlier observations
used two instances of `LegacyCompetitionAdapter`; those observations do **not**
establish independent parity and must be excluded from acceptance statistics.

For an authorized, sampled legacy competition detail GET, the baseline reads
legacy wave/drop/rating/spending/decision/outcome/pause rows directly through
`LegacyCompetitionBaselineRepository`. The candidate reads the public domain
resources through `LegacyCompetitionAdapter` and its paged repository queries.
No native runtime or mirrored native vote data is required. Capability expectations
come from the configured special-wave IDs; the candidate uses the stored
competition capability assignments, so missing mappings are detectable. When a
special-wave environment ID changes, update its stored capability assignment
before sampling. An environment/mapping mismatch is configuration drift to
investigate, not proof that the read adapter is broken.

Both paths use one repeatable-read transaction on the primary/write pool and
the same timestamp. The primary is intentional: the transaction also writes the
observations and must avoid replica lag between the two projections. This
prevents a concurrent vote or phase transition from creating a false mismatch.
All 12 supported category observations commit together; collection, mapping,
or persistence errors roll back the sample and leave the requested read intact.
An attempted sample logs identifiers, `outcome`, `reason`, and `duration_ms`,
never the exception or source data. Reasons distinguish `in_flight`, `row_limit`,
`deadline_exceeded`, `sample_failed`, and committed `complete` samples. Count
these log events and aggregate duration to monitor skipped-sample rates and
latency. Query the committed observations for acceptance; per-category
logs emitted before a failed transaction are not committed evidence.

Sampling is bounded to one in-flight sample per API process and 10,000 rows per
legacy source or candidate collection. It uses the existing physical SQL budget:
a 2-second overall deadline (including acquisition/finalization), 500 ms maximum
per statement, and a 250 ms finalization reserve. Expiry aborts work, rolls back
or discards the connection, and releases sampling capacity. Candidate detail
reads are sequential so they share that budgeted connection safely. The GET
awaits this bounded work; it is not detached into work that Lambda may freeze.
Larger samples are skipped entirely,
never truncated and counted as matches. The percentage flag remains the rollout
rate control; this is not a cluster-wide quota. Measure query cost, sample skips,
and request latency before enabling sampling outside a local fixture environment.

Normalization compares legacy identities and semantic fields, not generated
resource IDs or storage metadata. Entry membership/status, vote totals and
spending, leaderboard order/rank/ties, executed decision winners, outcomes and
distributions, pauses, configuration/lifecycle, and capability assignments are
covered. Stable UUIDs, configuration-version binding, future phase calculations,
and public wire contracts retain their separate regression tests.

`CREDIT_AVAILABLE` is deliberately not emitted. The v3 voter snapshot exposes
`votes` and `credit_spent`, not a derived remaining-credit budget. The original
comparator incorrectly labeled a voter-array equality check as remaining-credit
coverage. Independent remaining-credit validation is still an explicit roadmap
acceptance gap; a green spending sample cannot satisfy it.

Example observation query (read-only):

```sql
select category, matched, count(*) as observations
from competition_parity_observations
where source_version like 'legacy-read-v2:%'
  and observed_at >= :rollout_started_at
 group by category, matched;
```

Deployed observations use the workflow-provided `GIT_COMMIT` revision, with
`GIT_COMMIT_SHA` also supported. For release acceptance, filter by the exact
`legacy-read-v2:<deployed-sha>` value; `legacy-read-v2:local` is only a local
development fallback.

## Local Foundation Follow-up (2026-09-28)

The follow-up changes only the API's shadow-read implementation and local
validation. It adds no schema, worker, mutation, public API, or frontend runtime
contract. For this delta, the only deployable service is **`api`** (Lambda `seizeAPI`), after confirming
the original additive tables/mappings already exist. Do not redeploy migration
or decision/leaderboard workers solely for this follow-up. A later frontend
migration must still follow successful backend deployment.

Local tests and merges do not prove staging delivery, production sampling,
latency thresholds, or the remaining-credit acceptance criterion. Those remain
separate gates. No shared-environment rollout was performed for this follow-up.

## Rollback

Set `FEATURE_UNIFIED_COMPETITION_READS=false` and
`FEATURE_LEGACY_COMPETITION_SHADOW_COMPARE=false`, then redeploy the API. This
makes the v3 resources unavailable and stops comparison work while every
existing GET continues through its current route. Keep the three native
mutation/execution controls false.

Do not drop or reverse the additive schema during an incident. Existing workers
and ordinary wave writes still depend on immutable legacy-primary mappings
with v3 disabled. Disabling the two read controls
stops v3/shadow work without moving ownership or creating duplicate side effects;
it does not remove the foundation from ordinary wave writes or legacy workers.
