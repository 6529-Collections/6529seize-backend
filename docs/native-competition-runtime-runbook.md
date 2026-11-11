# Native Competition Runtime

A wave owns chat, visibility and administration; each native competition owns
configuration, entries, votes/credits, schedule, decisions, awards and history.
Original-primary identity remains immutable for permanent old public GETs.

## Deployment and operation

Follow the [final cleanup procedure](competition-storage-cleanup.md) for the
compatible schema/consumer rollout and intentional physical deletion. The old
global rollout/shadow flags, storage selector and migration tools are removed.
Publication, ACTIVE/DISABLED execution, pauses, capabilities and authorization
remain runtime controls.

Rollback must preserve native ownership, accepted outbox events, effect/delivery
receipts, command receipts, signatures and history. After physical deletion use
compatible native code or the verified isolated recovery snapshot. A committed
external claim or announcement cannot be undone by a code rollback.

## Command and signing contract

Commands use a UUID `idempotency_key` in the JSON body and return HTTP 200,
matching generated-router support. The receipt key includes the effective
actor. Identical retries return the committed response; changed payloads under
the same key return 409. Receipt, domain writes, nonce consumption and outbox
events commit together. Moderation preparation runs before the entry/hub
transaction; publication authorization and constraints are checked inside it.

Publishing a draft fails with 409 `PUBLISHED_COMPETITION_LIMIT` when its wave
already has `COMPETITION_MAX_PUBLISHED_PER_WAVE` (default 25) published
competitions, or the profile that created the draft already has
`COMPETITION_MAX_PUBLISHED_PER_CREATOR` (default 50) across waves. Paused
competitions count; ended, cancelled and archived ones do not. `0` turns a cap
off. Concurrent publications of different drafts are not serialized, so a cap
can be exceeded by the number of simultaneous publish requests.

Every update/action supplies `config_version`. Stale versions return 409.
Published types cannot change. After the first accepted entry, credits,
signing, timing, decisions and outcomes are immutable. Participation and voting
access, title, description, guidelines and presentation can change with a new
audited version. Terminal
competitions cannot reopen; cloning creates a separate draft. Publishing a
clone requires valid future dates.

Immutable original primaries retain their established administrator edit policy
through native commands. Server permissions expose `edit_rules_after_activity`
and `edit_credit_rules`; neither default navigation nor sibling identity can
grant them. Type, identity strategy and outcome definitions stay fixed. Voting
credit sources and negative-vote rules lock after the first accepted vote,
including reset/deleted history. Entry vote limits may only increase; changed
schedules must start in the future, overdue decisions must resolve first, and
approval winner limits cannot fall below completed decisions. Newer competitions
keep the published-rule lock after activity. Unrelated settings edits preserve
shared appearance inheritance and the progressed native decision cursor.

Before enabling signed native participation, configure backend `API_BASE_URL`
for that deployment and frontend `API_ENDPOINT` to the same API host (including
non-default port). Signed commands fail closed when backend `API_BASE_URL` is
missing or invalid. Use HTTPS outside local development; do not share the API
audience across staging and production.

Native signatures use canonical JSON with recursively sorted object keys and
ordered arrays. The envelope contains `domain=6529-competition-v1`, the API
host `audience`, Ethereum mainnet `chain_id=1`, action, actor profile and lowercase authenticated wallet, wave/competition/entry/drop
IDs, config version, SHA-256 payload hash, UUIDv4 nonce, issued time and expiry.
Lifetime is at most five minutes. EOA and existing EIP-1271 verification are
supported. Proxy scope and current eligibility are checked independently.

Entry payloads bind their newly submitted drop content. Existing chat drops
cannot be attached as entries. Vote payloads bind the
signed value, including zero/removal and negatives. Signing is separate from
the legacy drop signature. Raw signatures and original signed payloads stay in
restricted content-version/command tables; public content is an allowlisted
projection with signature null. Do not log these rows.

## Execution and content invariants

Maintenance keeps the existing competition row lock and transaction. WAVE
budgets use bounded source pages; voters within their available credit need no
individual vote reconciliation. REP and NFT credit sources retain their existing
budget formulas and DROP scope still checks each entry. Leaderboard upserts and
runtime threshold updates batch 100 entries at a time on the same connection.
All batches, stale-entry cleanup and the outbox event commit or roll back together.
A failed pass leaves all of these unchanged. The next scheduled pass recomputes
current state; existing decision IDs and semantic outbox keys retain retry safety.

Successful scheduled passes emit `native_competition_execution_completed` with
`competition_id`, `operation` (`leaderboard` or `decisions`) and `duration_ms`.
This elapsed duration includes lock acquisition and commit, so it is an upper
bound on lock hold time, not a separate lock-duration measurement. Use it instead
of relying on large detailed timer reports that may be truncated. Ordinary
refreshes and decision catch-up can have different costs; credit reductions and
winner processing still run under the lock.
Acquisition wait can inflate this duration under contention. Compare baselines
and choose alert thresholds separately for leaderboard refreshes and decision
passes, accounting for decision catch-up. Failed passes log the same operation
and elapsed duration with `native_competition_execution_failed`.

The decision worker resumes after the competition its previous pass last
started (`competition_worker_cursors`, worker `native_decisions`) and wraps
around, so a pass that stops early is continued instead of restarted. It stops
starting competitions after `WAVE_DECISION_LOOP_DECISIONS_BUDGET_MS` (5 min)
or with less than 5 minutes of the invocation left, and logs
`native_competition_execution_deadline_passed` for a competition still running
after `WAVE_DECISION_LOOP_COMPETITION_DEADLINE_MS` (2 min) while it moves on.
That run still commits or rolls back as usual; the pass waits for it before
returning and keeps at most two such runs in flight. A pass that stopped early
or overran logs `native_competition_decision_pass_bounded`. Outbox delivery
runs before (up to `WAVE_DECISION_LOOP_DISPATCH_FIRST_MS`, 60 s) and after the
pass, claiming decision results first. Scoring still replays each
competition's full history; making it incremental is separate work.

- Competition row locks serialize entry/vote/lifecycle/execution changes.
  Drop locks additionally prevent concurrent association, editing and deletion
  from bypassing one active nonterminal entry per drop.
- Budgets are independent per competition and derive from current TDH, REP,
  xTDH, combined TDH/xTDH or configured NFT TDH. WAVE scope locks the sum of
  absolute active votes. DROP scope requires an entry for meaningful spend and
  remaining values. Winning or deleting an entry releases spend while
  preserving vote history. Native negative credit reductions truncate toward
  zero, avoiding legacy negative-floor overspend.
- Native vote commands and migrated legacy rating requests reconcile the
  acting voter's credit before validating the requested replacement, under the
  existing competition lock. Vote state, current aggregate, history, metrics,
  notifications and durable vote events commit together. Saves do not reconcile
  other voters or refresh the full leaderboard. The existing snapshotter and
  decision workers perform competition-wide reconciliation and standings
  refreshes; a confirmed vote's rank/time-weighted score can update on the next
  worker pass. Verify both workers are active and healthy before deploying this
  API and worker versions must share the native history contract during rollout.
  Reversal tooling is retired; preserve all accepted native events.
- Each voter may change votes in one competition at most
  `COMPETITION_VOTE_CHANGES_PER_MINUTE` times per minute (default 120, `0`
  turns it off), counted in Redis per voter, competition and minute for native
  vote commands and legacy rating requests alike. Only changes count; resending
  the current value does not. A change past the budget returns 429
  `VOTE_CHANGE_LIMIT` with `retry_after_seconds` before anything is written.
  While Redis is unavailable changes are admitted.
- Pause decisions leaves otherwise eligible entries/votes available. Rank
  occurrences inside an inclusive pause are skipped without shifting future
  occurrences. Approve evaluates accepted votes on resume, including a hold
  that finishes after voting closes. Voting-end equality remains accepted.
  Pausing requires a nonblank reason; the Configuration view exposes the
  competition's historic pauses, reasons and start/end times.
- Rank and Approve store immutable winner/voter snapshots and award
  descriptors. Outcomes are optional: a scheduled Rank decision without outcomes
  selects one winner, and Approve still uses its threshold and winner limit;
  neither creates placeholder awards. Configured Rank distributions retain their
  existing winner counts. The frontend presents configured outcomes in Settings.
  Winning changes an entry, never its dedicated COMPETITION drop. Existing
  automatic REP/CIC outcome behavior creates descriptors, not new rating grants.
  Original-primary PARTI/WINNER wire classifications derive from native entries;
  no physical drop lifecycle mirror is written.
- Administrators may archive drafts, published and completed competitions;
  filters retain access to history. Published archival disables execution and
  rejects new entries/votes under the same competition-row lock used by
  submissions, voting and decisions. A decision holding that lock finishes first;
  later attempts observe the archived lifecycle and do nothing. Existing
  entries, votes, winners and awards are retained without manufacturing an end
  time. Archive does not require or retain a reason. Pause reasons remain in
  the separate public pause history. Lifecycle audit events retain lifecycle,
  actor and timestamp only.
  Existing Main Stage winners remain eligible for delayed claim delivery after
  archival. Deploy `claimsBuilder` first so queued claims accept archived winners,
  then `waveDecisionExecutionLoop` so delayed decisions still enqueue those claims.
  After the decision worker deployment succeeds, allow 900 seconds for old in-flight
  claims/decision invocations to drain before deploying `api`, then the dependent
  frontend controls. Both workers have a 900-second maximum runtime; the new
  consumers remain compatible with the existing API during this window.
  Removing the lifecycle audit reason column requires updating all writers first:
  deploy `waveDecisionExecutionLoop`, then `api`. Allow 900 seconds after the
  worker update and 30 seconds after the API update for old invocations to drain.
  Then deploy `dbMigrationsLoop` with `db_schema_scope=competition-lifecycle-events`
  to synchronize only that entity and drop `competition_lifecycle_events.reason`,
  including its stored values. Deploy the dependent frontend last. Other lifecycle
  fields and `competition_pauses.reason` remain intact. Do not roll back
  to a reason-writing API or worker after the column has been dropped; first
  restore the nullable column, whose old contents cannot be recovered by sync.
  Manual end/cancel and entry withdrawal/disqualification are not exposed.
- Dedicated native submission content is immutable, including unsigned entries.
  A migrated original legacy submission retains its original pre-winner edit
  behavior through entry-owned commands; it is not a dedicated native submission.
  Deletion uses existing drop permissions and preserves competition history. Public historical
  content observes current moderation/deletion access, so snapshots cannot
  resurrect removed content. Ordinary chat-history purge excludes competition
  content. A wave containing any native history cannot be deleted.

## Privileged capabilities

Ordinary wave administrators cannot assign capabilities through competition
configuration. Use the operations command with an explicit allowlisted actor
who is also a current wave administrator:

```sh
6529 run competition:capability -- --wave <wave-id> --competition <competition-id> \
  --capability MAIN_STAGE --action assign --actor <profile-id> \
  --reason 'Approved designation' --idempotency-key <uuid>
```

This performs a dry run. Add `--live` only for an authorized mutation. Configure
`NATIVE_COMPETITION_CAPABILITY_OPERATORS` as the explicit comma-separated
operator-profile allowlist. Supported names are `MAIN_STAGE`, `CURATION`,
`QUORUM`, and `ANNOUNCEMENTS`. Assignment/removal is unique per competition and
capability, serialized under the competition lock, recorded with actor/reason,
and immutable after participation or a terminal state. Legacy assignments are
not changed by this command. Privileged competitions require a public hub and
public parents; public effects also recheck that boundary when executing.

Main Stage claims and meme-card mapping require the designated winner entry
and its exact claim provenance. Another competition in the same wave gains no
privilege. Stable effect IDs include competition/decision/entry context. SQL
receipts prevent repeated notifications and announcements; leased outbox rows
support retry after worker interruption. Do not clear receipts to retry work. Native
entry events retain the committed mention/reply push IDs. Queue exceptions or
partial batch failures keep native events pending for retry; lifecycle retries
reuse notification IDs from effect receipts. Existing worker delivery receipts
deduplicate repeated queue messages. Immediate chat cache/socket delivery is
best effort, with stage and allowlisted error-code diagnostics; logs exclude
provider payloads and signatures.

Only winner notifications are emitted for native competition lifecycle events;
entry, vote, publication and other lifecycle events do not create these alerts.
Individual vote changes separately use the existing `DROP_VOTED` notification,
just like legacy voting. The submission author receives the voter's new vote,
the signed change from their previous vote, and the submission's current total.
Vote increases, reductions, removals, and negative votes follow the same rule.
Self-votes, unchanged replacement votes, and retried commands do not create
additional notifications. The notification and its durable push-outbox record
commit with the vote, using the wave's visibility group and the existing
notification preferences, mute, and moderation filters. This applies to all
native competitions, including migrated Main Stage submissions.

Existing notification clients keep their original causes and unread counts.
Native clients opt into `COMPETITION_LIFECYCLE` using
`include_competitions=true` on `GET /v2/notifications`. V1 and default V2
requests exclude those rows, including from the unread count. Push registration
separately records the same explicit capability per device; older devices do
not receive native competition pushes or count them in their badge. Registering
without the capability clears it, including after an app downgrade.

The paragraphs about individual vote notifications above are backend-owned
help knowledge. This backend-only fix does not publish a frontend help-index
update; the live help bot corpus needs a separate update to describe native
competition vote notifications explicitly.

## Verification gates

Verify additive schema synchronization, permanent GET projections, independent
history parity, private/parent access, proxy/group revocation, concurrent votes,
command/signature retries, delayed decisions, pause/hold boundaries and duplicate
delivery. Exercise original primaries and native siblings, including special
capabilities independently from ordinary competitions in the same hub.

Inspect outbox backlog, oldest pending event, retries/leases, decision lag and
receipt/claim counts. Record deployed versions, health and relevant E2E evidence.
A passing disposable test is not environment parity evidence. Follow the
[cleanup procedure](competition-storage-cleanup.md) for physical deletion and recovery.
