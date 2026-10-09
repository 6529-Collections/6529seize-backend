# Drop Forge Auto Launch — Backend Requirements Analysis

Status: original requirements analysis, 2026-10-09, retained as design context.
The backend implementation now accompanies this analysis. Confirmed choices and
remaining rollout boundaries are in [the operational guide](../../../docs/drop-forge-auto-launch.md).
AWS KMS signing is approved; automation and preparation workers default to disabled.
Frontend operator controls remain future work. No deployment has occurred.

Companion: [frontend requirements PR #4207](https://github.com/6529-Collections/6529seize-frontend/pull/4207).

## Purpose and confirmed scope

Allow a prepared Drop Forge claim to launch through its configured phases
without an operator being present for each transaction. Backend owns execution,
secure signing, durable progress, recovery, wave reporting, and notification
recipient resolution. Frontend owns configuration and operational visibility.

Confirmed scope includes an operational wallet with on-chain creator-admin
permission; claim initialization and phase updates; subscriber airdrops; an
activity feed to a manually supplied wave; the global mention
`@dropforgers6529` with manually supplied profile IDs; and investigation and
fixes for reported EMMA phase-download/finalize timeouts. Other airdrop categories
must be enumerated before implementation rather than implicitly enabled.

The trigger proposed here is EventBridge and a backend worker. Specific APIs,
service names, signing provider, retry limits, and timing policy remain design
decisions. Winning-submission selection and craft approval remain inputs to this
launch workflow, not newly automated behavior in this proposal.

## Current code evidence

- [Claim action persistence](../../../src/api-serverless/src/minting-claims/minting-claim-actions.db.ts)
  stores completion flags and audit wallets/timestamps, not transaction hashes,
  nonces, frozen inputs, or durable batch execution state. It is not sufficient
  as the automation execution ledger.
- [Claim action authorization](../../../src/api-serverless/src/minting-claims/minting-claim-actions.authorization.ts)
  accepts configured claims admins or creator admins. API authorization does
  not provide a private key or on-chain signing authority.
- [Subscription phase routes](../../../src/api-serverless/src/subscriptions/api.subscriptions.routes.ts)
  process the phase download synchronously. The GET fetches upstream operations,
  phase results/name, updates subscription assignments, populates distributions,
  invalidates caches, and only then returns the downloadable results.
- [Subscription processing](../../../src/api-serverless/src/subscriptions/api.subscriptions.allowlist.ts)
  calls `ALLOWLIST_API_ENDPOINT` and updates subscription rows during list
  preparation. A download is therefore also a mutation; a timed-out client
  response does not prove that no writes occurred.
  Processing filters out subscriptions already assigned a phase, so repeated
  preparation must be audited for changed outputs after an earlier partial or
  completed request, not assumed to be an equivalent retry.
- [Finalize route](../../../src/api-serverless/src/distributions/api.distributions.routes.ts)
  calls `populateDistributionNormalized` synchronously through
  `POST /distributions/:contract/:id/normalize`.
- [Normalization](../../../src/api-serverless/src/distributions/api.distributions.service.ts)
  loads distribution rows, resolves wallet displays, builds normalized rows in
  memory, then replaces the normalized dataset in a DB transaction using a large
  insert. That transaction protects its replacement writes; it does not by
  itself establish consistency with concurrent phase preparation.
- [Wave notifier](../../../src/subscription-wave-notifier.ts) already supports
  configured wave/profile IDs and internal drop creation. Global developer
  mentions resolve configured profile IDs in
  [drop creation](../../../src/drops/create-or-update-drop.use-case.ts).

These are investigation leads, not a verified root cause of reported timeouts.

## BE-1: Prepared launch plan and execution state

1. Persist chain, creator contract, claim ID, published metadata, edition size,
   payment receiver, per-phase prices/windows/roots, and airdrop inputs in a
   versioned plan. Require explicit arming after preparation validation.
2. Bind execution to a completed distribution version and immutable recipient
   batches. Validate totals, address/count validity, phase completeness, root
   consistency, and edition limits before arming. Reject silent input changes.
3. Model draft, armed, running, paused, blocked, completed, and cancelled launch
   states separately from transaction submission/confirmation and notification
   delivery. Persist reasons and resumable progress.
4. Use atomic ownership/leases and version checks for conflicting worker,
   configuration, and manual actions. Define manual takeover: pausing prevents
   new submissions but cannot cancel an already broadcast transaction.
5. Expose authorized plan/status/control APIs with generated OpenAPI contracts.
   Synchronize frontend contracts in the same implementation task. Existing
   completion flags may be updated for compatibility after confirmed execution,
   but are not evidence sufficient to authorize replay.

## BE-2: Signing, permission, and money boundaries

1. Use a dedicated funded wallet granted creator-admin permission by the owner.
   Adding/revoking admins remains owner-only and outside automation.
2. Keep signing material out of source, browser bundles, logs, and wave content.
   Prefer a managed non-exportable signer; AWS KMS secp256k1 is a candidate,
   subject to Ethereum digest/signature compatibility validation. Confirm the
   signing provider before implementing its adapter.
3. Restrict service/IAM access and validate permitted chain, destination,
   methods, claim, arguments, and gas budgets before requesting signatures.
   Creator-admin privileges may be broader than this worker's intended actions;
   application checks do not narrow the underlying contract permission.
4. Recheck permission, balance, inputs, and on-chain state before submission.
   Record nonce and transaction intent durably; serialize submissions for the
   signer across claims and coordinate every service allowed to use that key.
5. Operational wallet pays gas; mint proceeds retain the configured receiver.
   Preserve receiver configuration rather than substituting the signer.
   Automating Pay Artist is excluded pending a separate payout decision because
   the current operation transfers ETH from the signing wallet's balance.

## BE-3: Trigger, sequencing, and timing

1. EventBridge wakes a worker to reconcile due actions with DB and chain state.
   Treat duplicate, delayed, and out-of-order delivery as expected. Choose
   between a periodic due-work loop and one-off schedules during design.
2. Initialize before dependent airdrops/updates. Define the exact required
   airdrop/phase order for the launch plan and confirm prerequisites on-chain.
   Do not advance dependent actions merely because a transaction hash exists.
3. Record UTC times and use on-chain configured windows as the minting
   authority. Scheduler invocation and transaction inclusion have different
   timing guarantees; do not promise exact-second phase changes.
4. Because phase updates can replace active configuration, define a safe
   transition schedule, acceptable lateness, gas escalation limits, and a missed
   window policy. Do not apply a stale phase or compress later windows silently.
5. Persist recovery across worker restarts, timeouts, provider outages, and
   missed invocations. Worker lifecycle polling is product behavior; this
   requirements PR does not create an operational poll or schedule.

## BE-4: Transactions and duplicate-airdrop prevention

1. Assign each action a stable identity including chain, contract, claim, plan
   version, action/phase, and deterministic batch identity. Hash recipient/count
   inputs, persist batch boundaries, and lock execution ownership atomically.
2. Persist the signed transaction/hash and nonce before broadcast, with a
   recoverable state for crashes between signing, broadcasting, and DB updates.
3. On uncertain submission, reconcile by hash/nonce and receipt. Rebroadcast or
   replace the same intended transaction under policy; never create a fresh
   airdrop simply because a request timed out or a notification failed.
4. Handle reverts, replacements, receipt confirmation depth, and reorgs. Confirm
   successful outcomes and reconcile on-chain effects before marking completed.
   Exact confirmation depth and fee/replacement policy remain open.
5. Reconcile existing manual actions before arming/takeover. Where historical
   airdrops cannot be established reliably, block for operator reconciliation;
   recipient balance or a checkbox alone is insufficient proof.

## BE-5: Activity feed and @dropforgers6529

1. Proposed configuration: `DROP_FORGE_OPERATIONS_WAVE_ID`,
   `DROP_FORGE_BOT_PROFILE_ID`, and
   `DROP_FORGERS_6529_MENTION_PROFILE_IDS` (comma-separated stable profile IDs).
   Operator supplies wave/recipient values through environment configuration or
   secrets; no real values belong in these documents. Names are proposed.
2. Validate author identity, wave access, and alert recipient configuration before
   arming. Proposed default is automation disabled when required configuration
   is absent/invalid. Wave posting identity is separate from on-chain signer
   authority; do not grant either role solely to obtain the other.
3. Post meaningful events: armed, initialization submitted/confirmed, airdrop
   batch submitted/confirmed, phase configuration updated, paused/blocked,
   failed, recovered, and completed. Include claim/phase, relevant counts, and
   descriptive transaction/claim links. Do not imply confirmed means the mint
   window has already started.
4. Persist an event outbox and delivery identity/drop ID. Retry reporting
   independently and reconcile uncertain publication before repeating it.
   A reporting outage must not replay chain actions or erase execution state;
   retain fallback operational logs/alerts when the wave itself is unavailable.
5. Implement `@dropforgers6529` as a global group mention following the existing
   developer mention pattern, with configured profile recipients and canonical
   notification metadata. Reserve its name against personal alias collisions.
   Recipients must pass existing visibility/access rules. Define invocation
   permissions explicitly; whether it is bot-only or available to other wave
   participants is an open product decision.
6. Tag actionable failures and exhausted retries, revoked permission,
   insufficient gas/balance, ambiguous chain state, or a missed schedule.
   Deduplicate alerts for an unresolved incident, include safe next action,
   and post recovery. Routine successful actions do not tag the group.

## BE-6: EMMA timeout investigation and reliability

1. Obtain affected plan/card/phase IDs, action, timestamps, HTTP status, and retry
   outcome. Correlate existing phase timers with upstream requests, DB timings,
   gateway/API limits, response sizes, and concurrent preparation/finalization.
   Do not assert a timeout root cause without this evidence.
2. Audit phase preparation, public/special phases, download exports, normalize,
   and reset interactions for partial writes, atomic publication, duplicate work,
   and inconsistent results on retry. Establish large-plan behavior and how
   subscription assignment affects subsequent phase processing.
3. Preferred design where measured request work is too long: explicit
   idempotent preparation/finalization jobs, quick acceptance with job ID, durable
   progress/result status, and read-only downloads of completed artifacts.
   Preserve existing clients through a documented compatibility transition.
4. Publish each complete result/version atomically. Coordinate finalization with
   phase preparation, freeze launch inputs, and bound/chunk heavy SQL or artifact
   generation where profiling identifies a bottleneck. Increasing HTTP timeout
   alone does not establish safe replay or completion semantics.
5. Define service authentication for automated upstream EMMA access. Do not
   depend on an operator's expiring browser JWT. Upstream
   `ALLOWLIST_API_ENDPOINT` implementation is outside the inspected local paths;
   a confirmed upstream defect may require separately scoped repository work.

## Acceptance scenarios for later implementation

| Scenario | Required outcome |
| --- | --- |
| Prepared launch with valid permissions and funded signer | Required actions execute in configured order and wave reports distinguish submitted/confirmed |
| Duplicate wakeups or two workers | One transaction intent per action/batch; no duplicate airdrops |
| Broadcast succeeds but worker/API times out | Resume reconciles the original transaction instead of issuing a fresh airdrop |
| Revert, replacement, or reorg | Completion follows policy and on-chain evidence; dependent actions remain blocked until safe |
| Manual takeover or plan change | New work stops/conflicting revision is rejected; outstanding transaction remains visible |
| Wave posting failure | Execution remains durable; notification delivery can recover independently |
| Actionable error | One incident alert tags configured eligible profiles; recovery is recorded |
| Slow/special EMMA phase or finalize retry | Discoverable durable outcome, consistent published data, and no duplicate processing |
| Input version changes after arming | Launch blocks or requires explicit revision/rearming |

## Implementation dependencies and open decisions

Resolve signer provider, recovery controls, gas funding/budgets, confirmations,
late-window policy, automated airdrop categories/order, bot author, mention
invocation policy, and EMMA reproduction evidence before implementation.
The manually supplied wave and profile IDs can remain unset until deployment
configuration, but arming must validate them.

Proposed delivery sequence: diagnose/fix EMMA preparation; add versioned state
and APIs; add mention/notification contracts; implement worker/signer/outbox;
integrate frontend controls; exercise failure and restart scenarios on testnet
before any separately authorized production rollout.

For a future implementation, likely deployment units are `dbMigrationsLoop`
for entity sync, `api`, a new worker, and any new preparation/notification worker.
Exact names and order must follow actual producer/consumer dependencies and the
current service catalog. This documentation PR requires no deployment and no
architecture diagram change. Later runtime/infrastructure changes must update
`docs/architecture.md` and relevant help-bot knowledge.

AWS references: [Scheduler delivery](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html),
[schedule precision](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html),
and [KMS key specs](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html).
