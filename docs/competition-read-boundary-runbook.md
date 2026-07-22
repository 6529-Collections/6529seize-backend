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

## Rollback

Set `FEATURE_UNIFIED_COMPETITION_READS=false` and
`FEATURE_LEGACY_COMPETITION_SHADOW_COMPARE=false`, then redeploy the API. This
makes the v3 resources unavailable and stops comparison work while every
existing GET continues through its current route. Keep the three native
mutation/execution controls false.

Do not drop or reverse the additive schema during an incident. Existing worker
ownership remains on immutable legacy-primary mappings, so disabling the two
read controls restores the pre-Phase-1 runtime path without moving ownership or
creating duplicate side effects.
