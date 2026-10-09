# Drop Forge automated launch operations

The backend implements a manually armed, default-disabled launch worker and a
separate default-disabled EMMA preparation queue. It does not select winners,
approve crafts, fund wallets, create keys, grant creator admins, or pay artists.
Frontend controls are still a separate implementation; the frontend companion
PR currently carries the requirements and generated API contracts.

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

## Prepare and arm

1. Publish claim metadata and edition size using the existing flow. The target
   claim must be uninitialized on-chain; automatic adoption is prohibited.
2. Queue one phase at a time using
   `POST /drop-forge/distribution-jobs/{contract}/{claim_id}` with a stable UUID
   `request_id`, `kind=PHASE`, `plan_id`, and `phase_id` (or `public`). Retrying
   the same request ID retrieves the same job. Completed phase inputs are reused
   until an explicit allowlist reset clears the preparation results.
3. Read `GET /drop-forge/distribution-jobs/{job_id}` on refresh for
   `PENDING`, `COMPLETED`, or `FAILED`. Download data is in `result_json`.
   A failed job is terminal; after fixing the cause, use a new request ID.
   Finalize through the same create endpoint with `kind=FINALIZE`, omitting
   phase/plan IDs. Distribution-admin authorization controls these APIs.
4. Save `PUT /drop-forge/launches/{contract}/{claim_id}` with `revision=0`
   for a new draft. Set `initialize_at` and each phase's exact distribution
   name, Unix-second `start`/`end`, `price_wei`, and explicit `is_public` flag.
   Artist and team airdrops require explicit opt-ins. Subscriber allocations
   across the prepared phases and general Airdrop rows are included.
5. Review `GET` on the same path. It exposes revision, configuration, roots,
   action states, recipient counts, and hashes; signed bytes are never returned.
   Use the latest revision in a `POST .../control` request with `operation=ARM`.
   Draft edits require the current revision. After arming, inputs are immutable.

Initialization needs at least 30 minutes before the first mint window, increased
for the airdrop batch count and confirmation policy. Airdrops use at most 100
recipients per transaction, with at most 20,000 recipients per plan. Every later
phase starts at least 15 minutes after the preceding window ends. Updates become
eligible after that preceding end, so they cannot replace a live mint window.
The worker stops creating or rebroadcasting transactions two minutes before an
action's deadline. Lead-time checks are a planning allowance, not a guarantee of
chain inclusion; a busy network or stuck transaction still requires attention.

All prepared allowlist phases must be mapped, non-public roots cannot be empty,
stored proofs must match the distribution, and normalization must be complete
before arming. Airdrops exceeding the edition size are rejected. Treat the
operational wallet and selected claim as exclusive to this worker while armed;
manual transactions or source changes cause a safety block. The initialized
on-chain token ID must match the prepared card/claim ID before any airdrop or
phase update.

## Timeouts and retries

An HTTP timeout does not prove that preparation failed. Finalization may finish
its writes after the client has disconnected, which explains a success visible
after refresh. The legacy normalize/download endpoints remain synchronous for
compatibility. Use the job API to make request completion independent of the
write workload; frontend adoption is still required to remove those waits from
the existing buttons.

Phase processing now commits subscription assignments, distribution rows,
Merkle data, and the downloadable result together. Concurrent retries share a
preparation lock and receive the stored result. Public subscriber results are
also persisted into the distribution. Finalization shares that lock and inserts
normalized rows in chunks. TDH enrichment fetches only intersecting wallet sets.
EMMA reads have a 20-second timeout and a 32 MiB response cap. Production traces
are still needed to attribute the reported timeout frequency and tune workload
limits; no production root cause or load-test result is claimed here.

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
outstanding intent still proceeds through signing/receipt reconciliation; wave
delivery failures do not cause replacement transactions. Missing wave/profile permissions require
operator correction. CloudWatch invocation-error alarms cover worker/config
failures when wave delivery cannot report an error. No live KMS key, funded
wallet, EMMA service token, or production wave was exercised in local validation.

## Future rollout order

Deploy `dbMigrationsLoop` for entity sync, then `api`, then
`dropForgeLaunchLoop` with both flags disabled. Redeploy the existing wave-report
consumers `subscriptionsDaily`, `subscriptionsTopUpLoop`,
`transactionsProcessingLoop`, `helpBotReplyLoop`, `nftsLoop`,
`mintAnnouncementsLoop`, and `waveDecisionExecutionLoop` so the new configured mention group resolves
consistently. Supply the recipient configuration to those services too. These
consumers can deploy after entity sync/API and before enabling the new worker.
No data migration is introduced. Enable and exercise a manually configured
Sepolia launch before a separately authorized mainnet rollout. No deployment is
part of this PR implementation request.
