# Native Competition Runtime

Native competitions share a wave's chat, visibility and administration. Each
competition owns its entries, credits, votes, schedule, decisions, awards and
history. Existing competitions retain the legacy engine and immutable primary
mapping. No legacy data migration is part of this release.

## Deployment order

This is an implementation runbook, not authorization to deploy or enable flags.
Keep all competition flags false during deployment. Deploy and verify each unit
before proceeding to its dependents:

1. `dbMigrationsLoop`: additive competition command/nonce, content-version,
   capability-audit, vote-history, runtime-state, decision voter-snapshot,
   outcome-award, outbox, effect-receipt and claim-provenance tables; nullable
   competition presentation column and default-false device notification
   capability. Rerunning the existing legacy backfill
   must not change primary IDs.
2. `claimsBuilder`, then `pushNotificationsHandler`: consume optional native
   claim context and competition winner notifications while retaining old
   messages. Old producers continue to work.
3. `waveLeaderboardSnapshotterLoop`, then `tdhLoop`, then `newsletterLoop` (production only),
   then `waveDecisionExecutionLoop`: reconcile native credits, refresh native
   standings, process decisions and dispatch durable events. Legacy routing
   stays active regardless of native flags.
4. `api`: deploy commands, content protection, scoped reads and native event
   production after their schema and consumers exist.
5. Frontend: merge/deploy only after every backend dependency is healthy.
   Frontend discovery and creation remain disabled by default.

No new Lambda, queue, schedule or public message channel is required. The
decision worker drains the competition outbox. Do not deploy a native producer
ahead of its consumers. Confirm actual workflow service names against the
service catalog before an authorized release.

## Activation and rollback

- `FEATURE_UNIFIED_COMPETITION_READS` enables scoped resources.
- `FEATURE_NATIVE_COMPETITION_WRITES` enables native administration and commands.
- `FEATURE_NATIVE_COMPETITION_EXECUTION` gates publication, entry/vote acceptance
  and native worker execution. Commands also require a published competition
  whose execution mode is `ACTIVE`.
- `FEATURE_NATIVE_COMPETITION_HUB_CREATION` enables hub-only creation.
- Frontend `NEXT_PUBLIC_FEATURE_MULTI_COMPETITION` enables discovery/creation
  controls.

Enable unified reads before writes, and enable execution consistently in API
and both native runtime workers only after their dependencies are ready. Draft
creation can be piloted with execution disabled. Publication, entry creation
and voting cannot. Never manually set a legacy adapter to native ownership.

Disable native writes and execution to stop new native activity while retaining
history and old clients. Disable hub creation separately. Hiding frontend
discovery alone is not a write kill switch. Leave schema, immutable mappings,
entries, votes, signature receipts, awards and outbox history intact; do not
drop tables or rewrite DropType as rollback. Inspect already committed outbox
effects and queue messages before deciding whether to drain or suspend the
producer. A rollback does not undo a committed external claim or announcement.

## Command and signing contract

Commands use a UUID `idempotency_key` in the JSON body and return HTTP 200,
matching generated-router support. The receipt key includes the effective
actor. Identical retries return the committed response; changed payloads under
the same key return 409. Receipt, domain writes, nonce consumption and outbox
events commit together. Moderation preparation runs before the entry/hub
transaction; publication authorization and constraints are checked inside it.

Every update/action supplies `config_version`. Stale versions return 409.
Published types cannot change. After the first accepted entry, credits,
signing, timing, decisions and outcomes are immutable. Participation and voting
access, title, description, guidelines and presentation can change with a new
audited version. Terminal
competitions cannot reopen; cloning creates a separate draft. Publishing a
clone requires valid future dates.

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
projection with signature null. Do not log these rows or add them to shadow
observations.

## Execution and content invariants

- Competition row locks serialize entry/vote/lifecycle/execution changes.
  Drop locks additionally prevent concurrent association, editing and deletion
  from bypassing one active nonterminal entry per drop.
- Budgets are independent per competition and derive from current TDH, REP,
  xTDH, combined TDH/xTDH or configured NFT TDH. WAVE scope locks the sum of
  absolute active votes. DROP scope requires an entry for meaningful spend and
  remaining values. Winning or deleting an entry releases spend while
  preserving vote history. Native negative credit reductions truncate toward
  zero, avoiding legacy negative-floor overspend.
- Pause decisions leaves otherwise eligible entries/votes available. Rank
  occurrences inside an inclusive pause are skipped without shifting future
  occurrences. Approve evaluates accepted votes on resume, including a hold
  that finishes after voting closes. Voting-end equality remains accepted.
  Pausing requires a nonblank reason; the Configuration view exposes the
  competition's historic pauses, reasons and start/end times.
- Rank and Approve store immutable winner/voter snapshots and award
  descriptors; winning changes an entry, never its dedicated COMPETITION drop. Existing
  automatic REP/CIC outcome behavior creates descriptors, not new rating grants.
- Administrators may archive competitions; filters retain access to history.
  Manual end/cancel and entry withdrawal/disqualification are not exposed.
- All submitted competition content is immutable, including unsigned entries.
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
Existing notification clients keep their original causes and unread counts.
Native clients opt into `COMPETITION_LIFECYCLE` using
`include_competitions=true` on `GET /v2/notifications`. V1 and default V2
requests exclude those rows, including from the unread count. Push registration
separately records the same explicit capability per device; older devices do
not receive native competition pushes or count them in their badge. Registering
without the capability clears it, including after an app downgrade.

## Verification gates

Before any pilot, verify schema sync twice, unchanged legacy GET projections,
independent budget shadow categories, private/parent access, revoked proxy/group
access, concurrent votes and entry association, command retries, signature
tampering/replay, delayed decisions, pause/hold boundaries and duplicate queue
delivery. Exercise Rank and Approve concurrently in one hub and a legacy
competition beside a native one. Verify native Main Stage effects separately
from an ordinary competition in the same wave.

Inspect outbox backlog, oldest pending time, retry attempts, lease expiry,
decision lag and receipt/claim counts. A passing local test is not staging or
production parity evidence. Record deployed revisions and related E2E results
before enabling a wider cohort. See the [read boundary runbook](competition-read-boundary-runbook.md)
for bounded independent legacy shadow sampling.
