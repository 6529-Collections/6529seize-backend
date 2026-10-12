# Drop Forge automated launch operations

EMMA exposes one durable **Process and Finalize** operation. Craft exposes
**Launch** after publication and **Update Claim** after republishing metadata.
The backend initializes immediately after Launch is accepted and continues phase
transitions from a one-minute EventBridge recovery schedule. Both workers default
to disabled. Winner selection, craft publication, keys, gas funding, creator-admin
grants, and Pay Artist remain operator responsibilities.

## Configuration and authority

Supply configuration through the existing environment/secrets loading path.
Keep signer settings stable until every outstanding transaction is reconciled.
The API and worker need the same launch configuration; notification-producing
services need the same `DROP_FORGERS_6529_MENTION_PROFILE_IDS` configuration.

| Setting                                 | Meaning                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `DROP_FORGE_AUTOMATION_ENABLED`         | Exact `true` enables transaction work; otherwise disabled                        |
| `DROP_FORGE_PREPARATION_ENABLED`        | Exact `true` enables queued EMMA preparation/finalization                        |
| `DROP_FORGE_CHAIN_ID`                   | Mainnet `1` or Sepolia `11155111`; defaults to Sepolia                           |
| `DROP_FORGE_CREATOR_CONTRACT`           | Single configured creator scope; required on Sepolia                             |
| `DROP_FORGE_LAZY_CLAIM_CONTRACT`        | Manifold proxy; defaults to the existing lazy-claim address                      |
| `DROP_FORGE_PAYMENT_RECEIVER`           | Fixed receiver frozen in each plan; required on Sepolia                          |
| `DROP_FORGE_SIGNER_ADDRESS`             | Expected operational wallet address derived from the KMS public key              |
| `DROP_FORGE_KMS_KEY_ID`                 | KMS asymmetric `ECC_SECG_P256K1`, `SIGN_VERIFY` key in the worker's AWS region   |
| `DROP_FORGE_WORKER_ROLE_ARN`            | Dedicated deployment/execution role; manually provisioned                        |
| `DROP_FORGE_OPERATIONS_WAVE_ID`         | Manually confirmed operations wave UUID                                          |
| `DROP_FORGE_BOT_PROFILE_ID`             | Existing bot profile UUID, with permission to chat in that wave                  |
| `DROP_FORGERS_6529_MENTION_PROFILE_IDS` | Manually supplied comma-separated profile UUIDs; all must exist and see the wave |
| `DROP_FORGE_CONFIRMATIONS`              | Confirmations before advancing, default 12, permitted range 2–64                 |
| `DROP_FORGE_MAX_FEE_PER_GAS_WEI`        | Required positive fee cap                                                        |
| `DROP_FORGE_MAX_GAS_PER_TX`             | Required positive gas-limit cap                                                  |
| `DROP_FORGE_MAX_TX_COST_ETH`            | Required positive total transaction cost cap                                     |
| `DROP_FORGE_EMMA_AUTH_TOKEN`            | Full Authorization header for a provisioned EMMA service account                 |

The separate `dropForgePreparationLoop` role is supplied through
`DROP_FORGE_PREPARATION_ROLE_ARN`. API roles need `lambda:InvokeFunction` on
`dropForgeLaunchLoop` and `dropForgePreparationLoop`; the preparation role needs
self-invocation permission. Scope those resources to the actual deployed function
ARNs. The preparation worker does not need KMS signing permission.
`DROP_FORGE_CALENDAR_BASE_URL` defaults to `https://6529.io` and supplies the
mint-day calendar used by the server to derive the fixed schedule.

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
payment receiver. Every worker transaction sends zero ETH; Pay Artist is excluded.

## Process, craft and launch

1. Actor 1 confirms the token ID in EMMA, uploads the artist/team allocations,
   and clicks **Process and Finalize**. The API returns a durable job immediately.
   The worker snapshots the three ordered upstream phase inputs, processes them
   and public subscriptions in checkpoints, then finalizes. Refresh retrieves
   progress; completion enables read-only paginated list downloads. Downloads
   cannot mutate assignments or normalize data. Reset explicitly invalidates the
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

For each initialization/transition, admission requires
`transaction_count * (confirmations * 12 + 60) + 120` seconds: Ethereum slot
budget, one scheduler interval per serial transaction, and the two-minute
no-new-submission cutoff. Ten-minute gaps are accepted when their own batch
count fits; a large later batch cannot borrow time before Phase 0. This allowance
is not a guarantee of inclusion/finality; reporting, RPC or network delays can
still block a launch. The worker starts no fresh transaction or rebroadcast in
the last two minutes, records receipts even when late, and blocks dependent work
if confirmation is observed at or after the deadline.

Phase updates snapshot the actual minted supply once the preceding window has
closed. Subsequent batches validate that persisted baseline plus only the
confirmed batches from that transition. Normal earlier-phase mints are therefore
allowed; unexpected supply changes inside the transition and insufficient edition
headroom block execution. Old flattened plans have no version-2 marker and cannot
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
back the unfinished stage, which the recovery schedule can retry. Ordinary stage
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

Unknown nonce consumption, a reorg, revoked admin permission, insufficient gas,
changed source/configuration, or a missed deadline blocks the launch and records
an error report with `@dropforgers6529`. `RESUME` requires the latest revision and
rechecks source, proofs, scope and timing. It does not replace a transaction,
reset a nonce, or replay a reverted airdrop. Outstanding transactions can block
other launches using the same signer until reconciled.

A signed intent with no canonical receipt may retain the shared signer lock
indefinitely, even if it never reached or disappeared from the mempool. This is
a known availability limitation. Do not clear that lock based solely on empty
RPC results or matching latest/pending nonces: the signed transaction can still
be broadcast later. A supported operator recovery endpoint is deferred; enabling
unattended operation requires a reviewed recovery path proving canonical nonce
consumption before releasing the signer. Never use a database reset as proof
that the transaction is invalid, and do not rebroadcast after the safe deadline.

For a stuck or unknown transaction, inspect the exact persisted hash/nonce and
canonical receipt before any operator action. There is intentionally no
automatic replacement, cancellation transaction, ledger reset, or fresh-plan
restart for a terminal claim. A manual recovery procedure/change must reconcile
the original nonce and resulting supply first. Keep the signed transaction
ledger protected: copying signed bytes permits later broadcast, and deadlines
cannot prevent a previously broadcast airdrop from mining late.

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
drains up to five events per launch, and the worker runs reporting both before and
after transaction work. Canonicality is rechecked against the latest confirmed
action; serialized actions share the same chain ancestry. Missing wave/profile
permissions require operator correction. CloudWatch invocation-error alarms cover
worker/config failures when wave delivery cannot report an error. Arming checks
the reporting bot's chat/visibility access and recipient visibility; actual
posting still passes the ordinary drop creation checks. Action reports
include chain-specific transaction links, batch counts and UTC phase windows.
No live KMS key, funded wallet, EMMA service token, or production wave was
exercised in local validation.

## Future rollout order

Deploy `dbMigrationsLoop` for entity sync, then `api`, then
`dropForgePreparationLoop` and `dropForgeLaunchLoop` with both flags disabled,
then the dependent frontend controls. Redeploy the existing wave-report
consumers `subscriptionsDaily`, `subscriptionsTopUpLoop`,
`transactionsProcessingLoop`, `helpBotReplyLoop`, `nftsLoop`,
`mintAnnouncementsLoop`, and `waveDecisionExecutionLoop` so the new configured mention group resolves
consistently. Supply the recipient configuration to those services too. These
consumers can deploy after entity sync/API and before enabling the new worker.
Apply the generated monitoring stack updates and deploy frontend mention
compatibility before enablement.
No data migration is introduced. Enable and exercise a manually configured
Sepolia launch before a separately authorized mainnet rollout. No deployment is
part of this PR implementation request.
