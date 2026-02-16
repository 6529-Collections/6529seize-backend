# Proxy Rating Credit Refunds (REP + CIC) with Exact Backfill

## Summary
Implement proxy credit accounting so proxy reductions refund credit and increases spend credit, keyed by `(proxy_action_id, matter, target_profile_id, category)`, with refund capped by previously outstanding spend on that key.

Confirmed rules/preferences:
- Refund when moving closer to zero: `ABS(new) < ABS(old)`.
- Spend when moving farther from zero: `ABS(new) > ABS(old)`.
- No credit change when equal abs.
- Matching scope is same target + category.
- Refund only when reducer is acting as proxy.
- Apply to both single and bulk flows.
- Include active-proxy predicate fix.
- Backfill is conservative on ambiguous rows.
- Reconcile `profile_proxy_actions.credit_spent`.
- MySQL 8 is guaranteed.
- Rollout mode: two-step safe rollout.

## Public Interface / Type Changes
No API contract changes.

Internal additions:
- New table constant in `src/constants/db-tables.ts`.
- New entity `src/entities/IProfileProxyRatingCreditBalance.ts`.
- Export entity in `src/entities/entities.ts`.
- New DB access module for balance upsert/adjust/query.

## Schema Changes
Create table `profile_proxy_rating_credit_balances`:
- `id BIGINT` PK auto increment
- `proxy_action_id VARCHAR(100) NOT NULL`
- `matter VARCHAR(50) NOT NULL`
- `matter_target_id VARCHAR(100) NOT NULL`
- `matter_category VARCHAR(256) NOT NULL`
- `credit_spent_outstanding BIGINT NOT NULL DEFAULT 0`
- `created_at BIGINT NOT NULL`
- `updated_at BIGINT NOT NULL`

Indexes:
- Unique: `(proxy_action_id, matter, matter_target_id, matter_category)`
- Index: `(proxy_action_id)`
- Index: `(matter, matter_target_id)`

No foreign keys, no DB enum constraints.

## Runtime Logic

### 1) Fix proxy-action active predicate
File: `src/api-serverless/src/proxies/proxy.api.service.ts`
- Fix `isProxyActionActive` so `revoked_at/rejected_at/start/end` checks are always evaluated, even when `end_time` is null.

### 2) Signed proxy credit delta
For proxy-auth rating edit:
- `absDelta = ABS(newRating) - ABS(oldRating)`
- `absDelta > 0`: spend `absDelta`
- `absDelta < 0`: refund `min(-absDelta, outstandingForKey)`
- `absDelta = 0`: no adjustment

Key: `(proxy_action_id, matter, matter_target_id, matter_category)`.

### 3) Replace best-effort credit updates with transactional updates
File: `src/rates/ratings.service.ts`
- Remove best-effort post-commit behavior.
- Apply rating write + identity update + logs/events + proxy credit adjustment in one DB transaction.

File: `src/profile-proxies/profile-proxies.db.ts`
- Add signed credit adjustment method for `profile_proxy_actions.credit_spent`:
  - Positive delta must satisfy remaining credit check.
  - Negative delta must not drop below zero.
- Add helper to upsert/update balance row for the key and return effective refund/spend.

### 4) Apply to both single and bulk flows
File: `src/rates/ratings.service.ts`
- `updateRatingInternal/updateRatingUnsafe`: use signed delta per key.
- `bulkRep` and CIC bulk path: compute per-row deltas and apply per key in same transaction.

## Backfill and Reconciliation (Exact, MySQL 8)
Migration SQL will:
1. Create new table and indexes.
2. Build ordered candidate stream from `profile_activity_logs` where:
- `type = 'RATING_EDIT'`
- `proxy_id IS NOT NULL`
- `additional_data_1 IN ('REP','CIC')`
3. Parse `old_rating/new_rating` from `contents`.
4. Resolve action context by joining:
- `profile_activity_logs.profile_id` -> grantor profile
- `profile_activity_logs.proxy_id` -> proxy profile
- `profile_proxies(created_by=grantor, target_id=proxy)`
- `profile_proxy_actions(proxy_id, action_type in ALLOCATE_REP/ALLOCATE_CIC)`
5. Replay chronologically with MySQL 8 window/CTE-based deterministic logic to compute outstanding per key with cap on refunds.
6. Insert final outstanding per key into `profile_proxy_rating_credit_balances`.
7. Reconcile `profile_proxy_actions.credit_spent = SUM(credit_spent_outstanding)` per action.
8. For ambiguous rows: skip (conservative), and write counts into migration diagnostics output.

## Deploy Plan (Two-Step Safe Rollout)

### Release 1
- Deploy schema migration (new table only).
- Deploy backward-compatible code that can operate with empty balance rows and writes new rows for new activity.
- Keep strict reconciliation checks in warning mode (log metrics, do not hard-fail mismatches).

### Backfill Window
- Run exact backfill migration/reconciliation SQL.
- Validate:
  - `credit_spent >= 0`
  - action-level `credit_spent` equals summed outstanding rows
  - sample proxy scenarios match expected refunds.

### Release 2
- Enable strict enforcement mode:
  - fail transaction on invariant violation
  - rely fully on balance table + signed deltas
- Keep observability queries/metrics for one release cycle.

## Test Cases

### Unit
- Spend on `ABS(new) > ABS(old)`.
- Refund on `ABS(new) < ABS(old)`.
- No-op on equal abs.
- Refund cap by outstanding.
- Same-target/category key isolation.
- Cross-target/category no refund leakage.
- Sign flip scenarios (`+50 -> 0`, `-50 -> 0`, `+50 -> -50`).

### Integration
- Primary scenario: `+500` then back to `0` under same proxy action results in net zero credit spent.
- Two-target split scenario (including opposite signs) behaves as expected.
- Owner direct edit does not refund proxy action.
- Bulk path equals single-path semantics.
- Concurrent edits preserve non-negative outstanding and valid action spent.

### Migration Validation
- Replay fixture logs with known expected balances.
- Ambiguous mappings skipped and counted.
- Reconciled action totals match summed outstanding balances.

## Assumptions
- Existing rating row key uniqueness remains `(rater_profile_id, target, matter, category)`.
- `matter_category` is always set (empty string allowed).
- Conservative backfill behavior is acceptable for ambiguous history.
- No API changes needed.
