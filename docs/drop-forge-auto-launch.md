# Drop Forge automated launch operations

For environment values, wave/profile access, AWS KMS/IAM provisioning and the
initial rollout without on-chain admin permission, use the maintained
[setup guide](drop-forge-auto-launch-setup.md). Update that guide alongside any
configuration, authority or deployment changes.

EMMA exposes one durable **Process and Finalize** operation. Craft exposes
**Launch** after publication and **Update Claim** after republishing metadata.
The backend initializes immediately after Launch is accepted and continues phase
transitions from per-drop one-time EventBridge Scheduler events. Both handlers default
to disabled. Winner selection, craft publication, keys, gas funding, creator-admin
grants and enabling optional artist payments remain operator responsibilities.

Both hub settings start Off. With tracking enabled, due disabled actions still report skips to the operations wave. Research and optional Pay Artist run together at 18:00 Europe/Athens the following day.

## Configuration and authority

Supply configuration through the existing environment/secrets loading path.
Keep signer settings stable until every outstanding transaction is reconciled.
The API and worker need the same launch configuration; notification-producing
services need the same `DROPS_6529_MENTION_PROFILE_IDS` configuration.

| Setting                                 | Meaning                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DROP_FORGE_AUTOMATION_ENABLED`  | Exact `true` enables launch tracking; the persisted Automatic launch switch separately permits execution                                 |
| `DROP_FORGE_PREPARATION_ENABLED`        | Exact `true` enables queued EMMA preparation/finalization                                                                                |
| `DROP_FORGE_SIGNER_ADDRESS`             | Expected operational wallet address derived from the KMS public key                                                                      |
| `DROP_FORGE_KMS_KEY_ID`                 | KMS asymmetric `ECC_SECG_P256K1`, `SIGN_VERIFY` key in the worker's AWS region                                                           |
| `DROP_FORGE_OPERATIONS_WAVE_ID`         | Manually confirmed operations wave UUID                                                                                                  |
| `DROP_FORGE_BOT_PROFILE_ID`             | Existing bot profile UUID, with permission to chat in that wave                                                                          |
| `DROPS_6529_MENTION_PROFILE_IDS` | Manually supplied comma-separated profile UUIDs; all must exist and see the wave                                                         |

The stage policy fixes network/creator/proxy/receiver, 12 confirmations, and gas
ceilings (100 gwei, 5,000,000 gas, 0.1 ETH gas cost per transaction). The explicit
`DROP_FORGE_MAX_ARTIST_PAYMENT_ETH` cap remains required before enabling payouts.
Deployment supplies the stage; no manual stage secret or calendar URL is needed.

Dedicated execution and Scheduler delivery roles are referenced by versioned
stage configuration, not GitHub variables. The API publishes targeted SQS work;
handlers consume only that job/claim and establish one-time phase/Research events
and outstanding-work watchdogs. The preparation handler has no signing permission.
See the setup guide for exact IAM grants, queue redrive and rollout ordering.
The server derives dates locally from the [shared Memes calendar](shared-memes-calendar.md). It stores the calendar version, Athens timezone and exact UTC phase timestamps when Launch is accepted. Metadata updates and newer calendar versions never recalculate an active launch.

Mainnet creator and receiver defaults follow the existing Memes flow. No private
wallet key is stored in the backend. The KMS public key must match the pinned
signer address. Configure the existing `ETHEREUM_RPC_URL` (mainnet) or
`ETHEREUM_SEPOLIA_RPC_URL` (Sepolia) HTTP(S) endpoint in both API and worker.
Signing uses the Ethereum unsigned transaction's Keccak digest,
KMS `MessageType=DIGEST`, and canonical low-s ECDSA recovery.
See [KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
for digest and signature encoding semantics.

The dedicated role needs the normal runtime DB/secret/log/VPC permissions,
`kms:GetPublicKey` and `kms:Sign` on this one key, plus the existing wave/push
delivery permissions. Apply the same restriction in the KMS key policy. Do not
grant signing permission to the API role. Provisioning IAM/KMS, environment
values, gas funds, and the creator owner's `approveAdmin` transaction are
separate operator work before enabling the worker. KMS cannot itself restrict
Ethereum calldata; the worker's IAM boundary and transaction checks enforce
this scope.

`CLAIMS_ADMIN_WALLETS` authorizes backend controls, but cannot sign on-chain.
Unconfigured controls callers must pass `isAdmin` on the fixed configured
creator. The operational wallet must independently pass that on-chain check.
Admin grant/revocation remains creator-owner-only. Mint proceeds use the frozen
payment receiver. Contract operations send zero ETH. Optional Pay Artist sends the frozen artist payment from the operational wallet, which must hold that amount plus gas.

## Process, craft and launch

1. Actor 1 confirms the token ID in EMMA, uploads the artist/team allocations,
   and clicks **Process and Finalize**. The API returns a durable job immediately.
   The clicking distribution admin supplies their current Authorization header;
   the API verifies admin access and stores it encrypted, bound to this job.
   The worker snapshots the three ordered upstream phase inputs, processes them
   and public subscriptions in checkpoints, then finalizes. Refresh retrieves
   progress; completion enables read-only paginated list downloads. Downloads
   cannot mutate assignments or normalize data. Once the input snapshot commits,
   the stored credential is cleared and subsequent stages need no EMMA login.
   An EMMA 401/403 or unavailable credential pauses the job as AWAITING_AUTH.
   Sign in to resume supplies fresh authorization to the same job, preserving
   checkpoints; any current distribution admin with EMMA access can resume it.
   Waiting jobs do not run repeatedly or allow conflicting distribution edits.
   Credentials also clear on failure/completion and never appear in API results,
   wave messages or plaintext persistence. Encryption derives a purpose-specific
   key from the existing JWT_SECRET shared by API and preparation worker; no
   additional token or encryption secret needs prepopulation.
   Reset explicitly invalidates the
   completed version; reset/upload operations conflict while processing is pending.
2. Actor 2 saves and publishes Craft, then clicks **Launch**. The API checks the
   completed distribution version, roots, edition, reporting access, and timing.
   It derives the standard windows from the mint calendar and immediately wakes
   the launch worker. Repeated clicks return the same armed ledger. No per-drop
   launch time or separate arm handoff is required. Initialization must confirm
   before Phase 0 opens; an insufficient remaining time budget rejects launch.
3. Craft shows initialization and update progress from the backend. After edits
   are saved and republished, **Update Claim** queues a metadata-only transaction.
   It preserves live phase windows, roots, prices, receiver and allocations.
   Urgent due phase work takes precedence. A newer publication can supersede
   an unsigned pending metadata request; an already signed/reserved transaction
   must reconcile before another publication can replace it. A completed launch can reopen for this
   update without resetting or replaying its airdrops. Edition/distribution
   changes are not metadata-only updates and require explicit recovery review.
4. Existing Launch controls remain available to contract admins. Before a wallet
   request the UI obtains a backend manual lease, pausing new automatic work.
   The transaction hash is submitted with its action category and persisted in
   the browser until accepted; refresh retries that submission. The worker waits
   for canonical confirmations, credits only the supplied allocations, and
   continues the remainder. Rejected wallet requests release the lease only if
   no nonce was consumed. An uncertain submission remains paused until its hash
   is reconciled or safe cancellation is proved.

A compatible initialized claim or already-applied phase configuration is observed
without another transaction. Manual hashes submitted before Launch are imported
when the ledger is created. Arbitrary transactions sent outside these coordinated
controls require supplying their hashes for reconciliation; minted supply alone
cannot prove which recipient/category received an airdrop. Unknown state blocks
execution rather than assuming allocations were delivered. Automation writes
completed category flags into the existing manual UI after all batches confirm.

The fixed schedule uses `Europe/Athens` wall time with DST: Phase 0
17:40–18:20, Phase 1 18:30–18:50, Phase 2 19:00–19:20, and public
19:20–17:00 the next day. Calendar timestamps resolve the actual mint day.
Launch eligibility starts at request acceptance; no earlier trigger is invented.
The legacy revisioned draft/control API remains available for compatibility.

Each phase has its own deterministic recipient batches (at most 100 wallets
per transaction, at most 20,000 phase-recipient entries per plan):

- Before Phase 0: initialize and airdrop Phase 0 subscribers plus selected
  general/artist/team allocations.
- After Phase 0 closes: update to Phase 1, then airdrop only Phase 1 subscribers
  before Phase 1 opens (18:20–18:30 in the standard schedule).
- After Phase 1 closes: update to Phase 2, then airdrop Phase 2 and public
  subscribers before Phase 2 opens (18:50–19:00). This follows the existing
  UI's grouping when public starts immediately at Phase 2's end.
- After Phase 2 closes: update to public. Because the standard schedule has no
  gap at 19:20, public activation necessarily waits for that transaction's
  inclusion; confirmation/reporting can follow later. It never replaces a live
  Phase 2 window. The cutover confirmation deadline is its due time plus one
  transaction's planning allowance, capped at the public end.
- At 18:00 the next day: Research becomes eligible, one hour after the
  calendar's public mint close. The target is `min(310, frozen Craft edition)`;
  the amount is `max(0, target - current on-chain total)`, counting paid mints
  and every earlier airdrop. Craft edition and on-chain `totalMax` must match.
  For edition 305 and total 287, exactly 18 tokens go to the existing Research
  wallet. An already-filled target completes without sending a transaction.
  Research uses a 24-hour execution/confirmation window after eligibility, with
  the same two-minute submission cutoff, gas limits and report gates. Scheduler
  or network delays can delay inclusion; 18:00 is eligibility, not guaranteed
  block inclusion. Supply is captured before reservation and rechecked before
  signing. Confirmed manual Research receipts are reconciled separately from
  subscriber allocations, and their supply reduces any remaining top-up.
  Completion mirrors `RESEARCH_AIRDROP` into Launch and posts wave activity with
  transaction links; failures use the existing `@drops6529` alert path.
  Optional Pay Artist is a separate action in the same post-mint group; an ordinary Research failure does not cancel its eligibility.

For each initialization/transition, admission requires
`transaction_count * (confirmations * 12 + 60) + 120` seconds: Ethereum slot
budget, targeted continuation/confirmation time per serial transaction, and the two-minute
no-new-submission cutoff. Ten-minute gaps are accepted when their own batch
count fits; a large later batch cannot borrow time before Phase 0. This allowance
is not a guarantee of inclusion/finality; reporting, RPC or network delays can
still block a launch. The worker starts no fresh transaction or rebroadcast in
the last two minutes, records receipts even when late, and leaves outstanding work
only for that action when its submission window expires. Confirmed late work is credited and never repeated; later groups retain their own eligibility.

Phase updates snapshot the actual minted supply once the preceding window has
closed. Subsequent batches validate that persisted baseline plus only the
confirmed batches from that transition. Normal earlier-phase mints are therefore
allowed; unexpected supply changes inside the transition and insufficient edition
headroom block execution. Current plans use version 4 and include the 18:00 post-mint
Research/payment group. Older plans (including version 3 with the earlier Research time) cannot
be armed, resumed, newly signed or rebroadcast; existing signed receipts remain
reconcilable. Recreate an unstarted draft, or manually reconcile a started ledger.

All prepared allowlist phases must be mapped, non-public roots cannot be empty,
stored proofs must match the distribution, and normalization must be complete
before launching. Airdrops exceeding the edition size are rejected. Do not use the operational signer for unrelated transactions. Manual claim work
uses the coordination endpoint; unknown nonce consumption or distribution changes
cause a safety block. The initialized
on-chain token ID must match the prepared card/claim ID before any airdrop or
phase update.

## Timeouts and retries

An HTTP timeout does not prove preparation failed. The single job makes request
completion independent of the write workload and refresh discovers its status.
Each phase's writes and checkpoint commit together. Lambda termination rolls
back the unfinished stage, which targeted queue redelivery can retry. Ordinary stage
errors become FAILED; correcting the cause and retrying uses a new request ID
and reuses compatible committed phase results. A completed job binds its
read-only lists to the distribution version. Source changes require reset rather
than silently mixing completed versions. Snapshot inputs are capped at 16 MiB;
upstream reads also have time and response limits.

Finalization uses chunked inserts and TDH enrichment reads intersecting wallet
sets. Legacy synchronous endpoints remain compatible. Production traces and
large-plan exercises are still required to confirm the reported timeout cause
and workload limits; no production root-cause measurement is claimed.

## Pause, cancellation and recovery

`PAUSE` or `CANCEL` prevents fresh signing and subsequent rebroadcasts when the
worker sees the control state. Previously signed or submitted transactions may
still mine; neither control can revoke them. The worker continues reconciling
their receipts while enabled. Disabling the runtime flag also disables receipt
reconciliation, so do not use it as evidence that the wallet is drained.

The signer row permits one outstanding action globally for the configured
chain/wallet. Signed bytes and hash commit before broadcast. Timeout, crash,
already-known response, and repeated EventBridge delivery can only retry those
same bytes. A confirmed receipt advances the ledger after the configured
confirmation count; a revert is terminal for that action. Previously confirmed
receipts are checked for canonical block hashes before proceeding or completing.
If an RPC cannot return a receipt's block, reconciliation retries without changing
the action or releasing its wallet reservation. An available block with a different
hash remains reorg evidence and still stops conflicting writes.

Unknown nonce consumption, a reorg, revoked admin permission, insufficient gas,
changed source/configuration, or a missed deadline blocks the launch and records
an error report with `@drops6529`. `RESUME` requires the latest revision and
rechecks source, proofs, scope and timing. It does not replace a transaction,
reset a nonce, or replay a reverted airdrop. Outstanding transactions can block
other launches using the same signer until reconciled.

An authorized Launch administrator can inspect the exact action, signer, nonce,
original/replacement hashes and allocation amounts. Recovery requests carry a
stable request ID, expected action hash and launch revision. The API queues work;
the same launch handler prepares and signs asynchronously through KMS. No signed
bytes are returned through the API.

`SPEED_UP` preserves the original nonce, destination, value and calldata and
raises both gas fee caps above all tracked attempts within configured budgets.
It requires the original execution window, frozen source and current claim
checks to remain valid. `CANCEL` signs a zero-value, empty-calldata transaction
to the operational wallet at the same nonce. The wallet must have no delegated
code. Cancellation supersedes unsigned speed-ups and prohibits further action
broadcasts; an already-broadcast original can still win. An existing matching
replacement/cancellation can be registered by hash through `RECORD_WINNER`.
Unrelated or mismatched transaction evidence remains blocked.

All attempts remain attached to one action. Recovery checks each canonical
receipt and waits until its block is finalized and the configured confirmation
threshold is met. Successful airdrops must have exact ERC-1155 mint events for
the frozen claim, recipients and quantities; total supply alone is insufficient.
Supply is read at the winning block. Before any fresh-nonce retry, canonical
finalized evidence is rechecked. A pre-finality reorg retains the reservation and
continues reconciliation. Unavailable/unknown evidence never releases the wallet.

Winning evidence, action outcome, manual completion flags, wallet release and
wave outbox entry commit atomically. Original or speed-up success credits the
action once, even when late. Cancellation/revert credits nothing and leaves
outstanding allocations visible. Later scheduled groups resume after finalized settlement when recovery interrupted automatic execution; an explicit operator pause remains paused. Unsuccessful actions still require reviewed recovery, never automatic replay.
`RETRY` permits reviewed outstanding work within its original execution window;
`DELIVER_REMAINING` permits airdrop delivery after all minting closes and opens a
24-hour operator recovery window. It preserves category and remaining recipients,
requires compatible current claim configuration and supply headroom, and rechecks
supply before signing. Research still derives its remaining target from fresh
supply. Terminal launches are not restarted; coordinated manual proof can credit
outstanding allocations instead. Every retry archives the settled nonce evidence.

The targeted handler always reconciles existing signed intents when configured,
including while execution is Off. No separate recovery flag is required.
Fresh-nonce retry/delivery still requires `DROP_FORGE_AUTOMATION_ENABLED=true`.
Provision keys, permission, reviewed stage policy and reporting configuration before use. Empty RPC
results, a timeout, a missed deadline, pause or launch cancellation never prove
that signed bytes are invalid. Never clear signer reservations through a DB reset.

Wave drop creation and acknowledgement commit together; a reporting retry does
not repost a committed event. Push delivery after that commit is best effort.
Before reserving the next action, the worker waits for prior wave reports. An
unsigned RESERVED intent waits for its pending wave reports before signing.
The worker rechecks acknowledgement under the signer lock before persisting a
signature, including reports added by concurrent controls. Candidate selection
uses the next unfinished action's due time, so future launches cannot hide due
work behind the scan limit.
Already-signed intent continues receipt reconciliation during a reporting outage;
wave delivery failures do not cause replacement transactions. Each reporting pass
drains up to five events per launch. A Launch invocation reports once before work
and after each of up to three work cycles; larger backlogs remain durable and
drain across targeted outstanding-work deliveries. New signing waits for the backlog
to clear. Canonicality is rechecked against the latest confirmed
action; serialized actions share the same chain ancestry. A confirmed on-chain
batch must be recorded together with wallet release in one database commit before
the next batch can reserve that wallet. A failed commit retains the earlier signed
intent for receipt reconciliation. Missing wave/profile
permissions require operator correction. CloudWatch invocation-error alarms cover
worker/config failures when wave delivery cannot report an error. Arming checks
the reporting bot's chat/visibility access and recipient visibility; actual
posting still passes the ordinary drop creation checks. Action reports
include chain-specific transaction links, batch counts and UTC phase windows.
No live KMS key, funded wallet, live EMMA authorization, or production wave was
exercised in local validation.

## Future rollout order

Confirm that the separately merged shared-calendar foundation is deployed in the
target environment as documented in [calendar maintenance](shared-memes-calendar.md).
Already-current `claimsBuilder`, `subscriptionsDaily` and `helpBotReplyLoop` do not
need redeployment for automation-only changes.
Deploy `dbMigrationsLoop` for entity sync, then `transactionsLoop` for finalized
creator scan coverage, then `dropForgeLaunchHandler`, then
`memesDistributionHandler`, then `api`, with both flags disabled, followed by the
dependent frontend controls. The new handlers create their own wave
reports; existing reporting services do not need redeployment for these alerts.
Make `DROPS_6529_MENTION_PROFILE_IDS` available to the API and both handlers.
Existing subscription alerts retain their `@devs6529` mention and configured wave.
Apply the generated monitoring stack updates and deploy frontend mention
compatibility before enablement.
No data migration is introduced. Enable and exercise a manually configured
Sepolia launch before a separately authorized mainnet rollout. No deployment is
part of this PR implementation request.

## Grouped readiness and wave reporting

Post-mint Research and Pay Artist now require matching configured-RPC/database
accounting at the same finalized post-close block, including completed indexing
coverage. The covered comparison block may be up to five minutes behind the
finalized tip; older or pre-close coverage defers execution. A wrong high count cannot authorize an already-completed skip. Launch
shows both counts, comparison block, indexing progress and next retry eligibility.
Discrepancies retry after 1, 5 and then 15 minutes within the existing window.
Signed transactions retain their hash and reservation; post-receipt evidence must
verify delivery before completion is credited. Unexpected delivery requires recovery.

The one-time 17:15 Europe/Athens preview is informational. It calculates the planned
18:00 Research/payment work, respects disabled settings and existing payment limits,
and reports normal results without tags. A discrepancy alerts once; it is not
recalculated on retry. Execution at 18:00 always uses fresh evidence. Only wave
delivery can retry for that stored preview. All these messages go exclusively to
`DROP_FORGE_OPERATIONS_WAVE_ID`. Existing mint announcements and
`DEPLOYER_ANNOUNCEMENTS_WAVE_IDS` are unchanged. Compact Markdown and small
type-specific emojis distinguish success, pending, skipped and warning posts.

The opening group contains initialization and general/artist/team/Phase 0 airdrops.
Subsequent phase groups contain their claim update and subscriber batches; Public
and Research retain the existing schedule. Group identity is returned with each
action, along with attempt count, readiness error, retry eligibility and observed
completion. Each group may span worker invocations while transactions confirm.

Each due action checks its own completed state and readiness. An initialization
or funding/admin failure stays on that action and does not suspend later groups.
Unsigned failures retry no more than once per minute while their submission window
is open. Expired work remains outstanding and is not sent late automatically.
Current matching configuration is read at the configured confirmation depth;
manual airdrops require confirmed exact ERC-1155 mint events and category-aware
remaining-allocation credits. A manual initialization and Phase 0 deliveries can
therefore be skipped while the next scheduled group proceeds without Resume.
A later update may advance any compatible earlier configuration once its own
scheduled gap opens. Missing initialization or incompatible state fails readiness.

The wave receives completion and transaction links, every actual failed attempt
with its error and alert mention, and a skip when already-completed work is first
recognized. Durable acknowledgements prevent repeated skip/completion posts.
An expired window is reported once, rather than producing a fake attempt every
minute. Reporting must commit before signing. Outstanding signed/unknown nonces,
manual leases and noncanonical evidence continue to stop conflicting sends.
Research waits for outstanding fixed airdrop allocations to be reconciled so its
dynamic top-up cannot consume the edition supply still owed to them.

## Launch Automation settings and artist payment

The Drop Forge hub shows Launch Automation to every authorized Drop Forge user.
Both database settings default Off, separately per chain/creator in each environment.
Only the current creator owner or `CLAIMS_ADMIN_WALLETS` can edit them. Ordinary
on-chain admins and `DISTRIBUTION_ADMIN_WALLETS` can view and fund the wallet.
These permissions are checked by the API, independently of the UI.

`DROP_FORGE_AUTOMATION_ENABLED` is the outer environment capability. Once provisioned,
set it to true to accept tracked Launch requests and install one-time schedules.
The hub's Automatic launch switch then controls new transactions. Off still allows
scheduled handlers to report each due action as skipped, once per settings revision,
without marking the action completed. Turning it on wakes active claims; only actions
still within their windows execute. No historical claims are created or swept.
Signed receipts continue reconciliation; Off stops fresh signing and rebroadcast,
not transactions already accepted by the chain. EMMA preparation remains independent.

Automatic artist payment defaults Off. At 18:00 Europe/Athens the following day,
its independent action checks the current settings, exact manual payment evidence,
completed fixed allocations and indexed supply against confirmed on-chain supply.
It uses the existing 50% share of standard-price paid mints plus redeemed
subscriptions, calculated with integer wei. The recipient comes from the claim's
payment details, including designated payees. Recipient and amount freeze with the
intent and are checked again before signing. Missing/incomplete accounting, a changed
payee/amount or a manual completion checkbox without a transaction blocks payment.
A zero amount completes without a transfer. The positive runtime
`DROP_FORGE_MAX_ARTIST_PAYMENT_ETH` cap is required before enabling payments; existing
transaction gas caps remain separate. Successful payment mirrors `PAY_ARTIST` into
the manual Launch view. Signed payments use the same wallet reservation, crash-safe
broadcast and canonical receipt/reorg checks as other actions. Speed-up preserves
the exact recipient/value/nonce; cancellation sends zero ETH to the signer.

The operational wallet panel shows its configured address, optional forward-verified
ENS name, correct-chain explorer link and ETH balance. Top Up ETH uses the connected
administrator's wallet; it does not ask KMS to sign. The user reviews the destination,
network, amount and estimated maximum gas fee before approving their wallet.
Funding is available while launch automation is Off. Submitted hashes are retained
for retrying registration, not for sending a second transfer. The handler tracks
same-nonce top-up replacements/cancellations and reports one confirmed outcome in
the operations wave. Funding reports do not authorize launch execution.
