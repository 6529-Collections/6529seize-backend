# Drop Forge launch automation setup

This is the setup guide for EMMA Process and Finalize, Craft Launch/Update Claim,
scheduled launch actions, and reports mentioning `@drops6529`. Operational behavior,
phase times, manual evidence and transaction recovery are described in
[Drop Forge automated launch operations](drop-forge-auto-launch.md). The
[architecture overview](architecture.md#drop-forge-automated-launch) shows the
components, queue delivery, signing boundary and exact scheduled groups.

**Maintenance:** update this guide in the same change whenever configuration,
deployment roles, signing permissions, reporting access or rollout behavior changes.
Keep `.env.sample`, the workflow generator and the companion frontend aligned.
Wallet and reporting identities remain operator-supplied; never commit real credentials or private keys. Contract bindings, chain and gas policy are versioned.

## 1. Choose the environment

| Deployment | Protected GitHub environment | AWS region | Ethereum chain |
| ---------- | ---------------------------- | ----------- | --------------------------------------------------------------- |
| Staging | `staging` | `eu-west-1` | Sepolia `11155111`, selected by the reviewed staging policy |
| Production | `production` | `us-east-1` | Mainnet `1` for real Memes launches |

Use separate KMS keys, operational wallets, waves, profile configuration and spending
limits for each environment. A profile or wave UUID must belong to the application's
selected environment. The deployment injects `DROP_FORGE_STAGE`; staging selects Sepolia and production selects mainnet. No feature-specific GitHub variable is needed.

Runtime configuration is loaded from AWS Secrets Manager **`prod/lambdas` in the
function's region**, including for staging. The API, launch worker and preparation
worker must read compatible configuration. The loader caches it in each warm process;
follow the normal service restart/redeployment procedure when changing configuration.
Changing a secret is not proof that every running instance has adopted it.

Execution role references are versioned in `serverless-config/{staging,prod}/drop-forge.js`.
No new GitHub environment variables or role secrets are needed. The existing
GitHub deployment authentication stays in place.
The API, launch handler, distribution handler and Memes transaction indexer receive `DROP_FORGE_STAGE` from their deployment. Do not put it in Secrets Manager. The handler stacks also inject `DROP_FORGE_SCHEDULE_GROUP` and
`DROP_FORGE_SCHEDULER_ROLE_ARN`; do not add these to the runtime secret. Queue
names are fixed in the stacks and discovered through SQS, so no queue URL setting
needs to be supplied manually.

## 2. Set up the wave and profiles

Create or choose a dedicated operations wave with chat enabled. Choose the profile
that should author reports and the profiles to notify on failures.

| Runtime setting | Required value |
| -------------------------------- | ------------------------------------------------ |
| `DROP_FORGE_OPERATIONS_WAVE_ID` | Operations wave UUID |
| `DROP_FORGE_BOT_PROFILE_ID` | Existing posting profile UUID |
| `DROPS_6529_MENTION_PROFILE_IDS` | Nonempty comma-separated recipient profile UUIDs |

The posting profile must see the wave (and its parent, if any) and have chat access.
Every alert recipient must be able to see it. Configure group membership accordingly.
The worker validates these permissions before accepting a launch and before reporting.

`@drops6529` expands to those recipients through the same global-mention mechanism
as `@devs6529`. It is a reserved mention shortcut, not a requirement to create a
profile with that handle. The posting profile may be separate from the KMS wallet.
No additional posting-profile authentication token or ENS name is required.

Make the recipient setting available to `api`, `dropForgeLaunchHandler` and
`memesDistributionHandler`. The new handlers create their own reports and resolve
mention recipients when creating each drop. Existing subscription and other
reporting services do not need redeployment or new recipient configuration for
these automation alerts. Their existing `@devs6529` alerts are unchanged.
The old shortcut and its old configuration key are not aliases for the new name.

### What tags the group, and where

| Source | When `@drops6529` is included | Wave destination |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `dropForgeLaunchHandler` | Recorded failures for initialization, claim updates, airdrops (including Research), signing/broadcasting and manual/recovery reconciliation | `DROP_FORGE_OPERATIONS_WAVE_ID` |
| `memesDistributionHandler` | Failed processing/finalization jobs or jobs paused because EMMA authorization expired/was denied; an explicit distribution reset does not tag the group | `DROP_FORGE_OPERATIONS_WAVE_ID` |
| A normal post containing the global shortcut | A chat participant includes `@drops6529` | The wave where the participant posts it |

Successful actions, already-completed skips and ordinary status reports go to the
same operations wave without tagging the group. The shortcut selects recipients,
not a destination: manually using it does not forward a post to the operations
wave. Recipient visibility and notification settings still apply.

Automation reports do not fall back to the subscriptions wave or a developer wave.
All posts introduced here, including the 17:15 post-mint preview, use only
`DROP_FORGE_OPERATIONS_WAVE_ID`. Existing mint announcements and
`DEPLOYER_ANNOUNCEMENTS_WAVE_IDS` are unchanged and never a destination for this
feature. Posts use compact Markdown and type-specific emojis, without large headings.
Failures that prevent creating a wave report remain observable through the existing
CloudWatch/Sentry monitoring and retained report retry state.

## 3. Create the AWS execution roles

In **IAM → Roles → Create role**, choose **AWS service → Lambda**. Create separate
execution roles for launch and preparation. Their trust
policies must allow `lambda.amazonaws.com` to assume them. Provide the usual scoped
runtime permissions for logs, VPC networking, Secrets Manager, database/Redis access
and the existing wave/push delivery path. Confirm network access to RPC, KMS, Secrets
Manager and the upstream APIs from the configured subnets.

Only the launch role receives `kms:GetPublicKey` and `kms:Sign`, scoped to the
operational key created below. Permit that role in the KMS key policy too. Do not
grant signing permission to the API, preparation role or shared Lambda role. Check
existing broad IAM grants when reviewing the effective key policy.

Role names are maintained in the stage configuration:

| Role | Staging name | Production name |
| ------------------- | --------------------------------- | ------------------------------ |
| Launch Lambda | `drop-forge-staging-launch` | `drop-forge-prod-launch` |
| Distribution Lambda | `drop-forge-staging-distribution` | `drop-forge-prod-distribution` |
| Scheduler delivery | `drop-forge-staging-scheduler` | `drop-forge-prod-scheduler` |

Serverless builds their ARNs using the deployment account and partition. Provision
these roles administratively before deployment; change the stage file if your approved
role names differ. These are separate roles, not aliases for the shared Lambda role.
The Scheduler delivery role trusts `scheduler.amazonaws.com`, restricted by
`aws:SourceAccount` and the ARN of `drop-forge-{stage}` schedule group. It can only
`sqs:SendMessage` to `drop-forge-launch`, `memes-distribution` and their `-dlq`
queues in the selected region. It has no KMS signing permission.

Required runtime permissions, scoped to this account and region:

- API role: `sqs:GetQueueUrl` and `sqs:SendMessage` on the two work queues.
- Each handler role: `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`,
  `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` and
  `sqs:SendMessage` on its own queue; existing wave/push delivery permissions.
- Each handler role: `scheduler:CreateSchedule` and `scheduler:DeleteSchedule`
  on `schedule/drop-forge-{stage}/forge-*`, plus `iam:PassRole` for only the
  Scheduler delivery role, restricted to `scheduler.amazonaws.com`.
- Launch alone: `kms:GetPublicKey` and `kms:Sign` on the exact operational key.
- Deployment role: existing scoped CloudFormation/SQS/alarms/event-source-mapping
  permissions, Scheduler schedule-group creation, and `iam:PassRole` on the two
  exact Lambda execution roles, restricted to `lambda.amazonaws.com`.

The API and handlers do not require `lambda:InvokeFunction` for this feature.
Review/apply the proposed `DropForgeHandlersDeployment.json` and
`DropForgeDispatchDeployment.json` supplements under
`ops/iam/backend-{staging,production}/`; their READMEs state the scope and remaining
administrative step. They have not been applied or AWS-validated in this change.
No permissions to edit arbitrary IAM policies are added to deployment. Ensure VPC
endpoints or outbound networking allow SQS and Scheduler as well as RPC/KMS/EMMA.

The handler Serverless stacks own their encrypted standard SQS queue, a 14-day DLQ,
and a CloudWatch DLQ alarm. Launch owns the `drop-forge-{stage}` Scheduler group.
Queues deliver one job/claim per invocation, with SQS maximum concurrency and
Lambda reserved concurrency both set to two. The SQL signer lock still serializes
transactions; a concurrently owned preparation checkpoint backs off instead of
spinning. Each invocation owns a separate watchdog. Standard queues can redeliver:
SQL locks, action readiness and persisted signed intents remain the safeguards
against repeated transactions; queue delivery alone is not an exactly-once guarantee.

## 4. Create the KMS wallet

In the AWS region selected above, open **KMS → Customer managed keys → Create key**:

1. Choose **Asymmetric** and **Sign and verify**.
2. Choose **`ECC_SECG_P256K1`** with AWS-generated key material. The NIST P-256
   option is a different curve and will be rejected by the worker.
3. Give the key a descriptive environment-specific alias and select its administrators.
4. Permit only the launch execution role to use it for the required signing operations,
   subject to your administrative access policy. Review both IAM and the key policy.
5. Record the key ARN. Keep this key stable while transactions or wallet funds exist.
   A replacement key has a different wallet address; do not repoint its alias during
   an active launch or assume it inherits funds or contract-admin permission.

AWS KMS retains the private key; there is no seed phrase/private key to put in
Secrets Manager. Retrieve the public key and derive the Ethereum address once.
From a configured backend checkout, with AWS access to `kms:GetPublicKey`:

```bash
aws kms get-public-key \
  --region <worker-region> \
  --key-id <key-arn> \
  --output json > kms-public-key.json

./bin/6529 exec node -e '
const { readFileSync } = require("node:fs");
const { createPublicKey } = require("node:crypto");
const { computeAddress } = require("ethers");
const key = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (key.KeySpec !== "ECC_SECG_P256K1" || key.KeyUsage !== "SIGN_VERIFY") {
  throw new Error("Wrong KMS key type");
}
const jwk = createPublicKey({
  key: Buffer.from(key.PublicKey, "base64"), format: "der", type: "spki"
}).export({ format: "jwk" });
const x = Buffer.from(jwk.x, "base64url").toString("hex");
const y = Buffer.from(jwk.y, "base64url").toString("hex");
console.log(computeAddress("0x04" + x + y));
' kms-public-key.json
```

Replace the angle-bracket placeholders before running. This downloads public
information and does not sign or send a transaction. Remove the temporary JSON file
after recording the address. Configure `DROP_FORGE_KMS_KEY_ID` with the **key ARN**
and `DROP_FORGE_SIGNER_ADDRESS` with the derived **Ethereum address**. The worker
independently verifies that they match before signing.

AWS references: [create an asymmetric key](https://docs.aws.amazon.com/kms/latest/developerguide/asymm-create-key.html),
[key specifications](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html),
[GetPublicKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html),
[Lambda execution roles](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html),
and [PassRole permissions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html).

## 5. Configure runtime settings

Add the reporting and wallet values above to the regional runtime secret, plus:

| Runtime setting | Meaning/default |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `ETHEREUM_RPC_URL` | Existing mainnet HTTP(S) RPC configuration |
| `ETHEREUM_SEPOLIA_RPC_URL` | Existing Sepolia HTTP(S) RPC configuration |
| `DROP_FORGE_MAX_ARTIST_PAYMENT_ETH` | Positive per-payment ETH cap, required before enabling Automatic artist payment; no default |
| `DROP_FORGE_AUTOMATION_ENABLED` | Default disabled; exact `true` enables scheduled launch work |
| `DROP_FORGE_PREPARATION_ENABLED` | Default disabled; exact `true` enables EMMA preparation/finalization |

Contract bindings, receiver, chain, confirmations and gas limits live in
`src/drop-forge/drop-forge.policy.ts`: staging uses Sepolia's existing creator,
production uses the Memes creator, and both pin the existing proxy and deployer
payment receiver. The reviewed gas limits are 100 gwei per gas, 5,000,000 gas per
transaction and 0.1 ETH maximum gas cost per transaction. Each limit applies
independently; gas is estimated and these are ceilings, not amounts to spend.
Change policy through a reviewed commit, not secret overrides. Artist payment
principal still requires its own explicit positive cap before opting in.
Retired chain/contract/receiver/gas/calendar/recovery override secrets have no effect;
remove them from the regional secret during rollout. Keep signer and stage policy
stable until outstanding transactions settle. An on-chain receiver mismatch blocks
execution and raises an alert; automation never adopts or repairs it silently.

The existing `JWT_SECRET` must match between API and preparation worker. EMMA uses
the clicking administrator's authorization, encrypted for the durable job. **No
EMMA service-account token or new encryption secret needs prepopulation.** Existing
EMMA endpoint configuration and the operator's upstream permissions still apply.

Initially set both execution flags to `false`; the two persisted UI toggles
also default Off. The preparation switch is independent of launch. Turning launch
execution Off prevents new scheduled transactions, while queued signed intents
continue receipt/replacement/cancellation reconciliation without a separate recovery
flag. Reviewed fresh-nonce retries still require launch execution to be enabled.

## 6. Deploy disabled, then observe without contract-admin permission

### Post-mint verification and the 17:15 preview

The existing configured `ETHEREUM_RPC_URL` (or chain-specific equivalent) and
the database must agree before Research or Pay Artist can be sent or skipped as
already satisfied. No second RPC provider, new contract or new RPC secret is added.
The comparison uses a finalized block after public mint closes, pinned by hash,
and cumulative DB mints through that same block. Burns do not reduce this count.
Use the latest finalized block covered by the durable indexer checkpoint, at most
five minutes behind the finalized tip. A moving tip does not require the indexer
to finish in the exact same second. Missing, older or pre-close coverage defers work.

The creator consumer in `transactionsLoop` records finalized scan coverage only
after normal discovery and an explicit bounded rescan succeed. Empty blocks are
covered; incomplete pagination or a changed block cannot advance the marker.
Existing transaction history is retained. `DROP_FORGE_AUTOMATION_ENABLED=true`
enables this coverage tracking for `DROP_FORGE_CREATOR_CONTRACT` (mainnet Memes
fallback); the normal indexing path and existing reporting destinations are unchanged.
Explicit start/end backfills do not advance normal coverage. The ordinary contract
history must already be complete; the marker does not certify or repair old data.
The existing transaction discovery service indexes mainnet. It publishes coverage
only for the versioned production mainnet policy, never under a Sepolia chain ID. Coverage indexing continues when launch execution is Off so already-signed post-mint transactions can settle. Full post-mint
Sepolia exercises require an isolated, correctly populated Sepolia transaction
index/database and its coverage checkpoint; the production indexer is not switched
to a test chain by the launch settings. Without that evidence, test-chain post-mint
work safely waits. Earlier signing/phase/recovery exercises remain separate.

At **17:15 Europe/Athens**, one queued preview calculates the Research remainder
and optional artist payment, showing whether automation/payment is Off or blocked
by its existing limit. A normal preview is untagged. A mismatch/unavailable-evidence
warning tags `@drops6529` once. Its stored result is never recalculated on retry;
only failed wave delivery can be retried. A missed preview is not calculated once
18:00 execution has started. The preview does not sign or approve a transaction.

At **18:00**, execution obtains fresh evidence. Disagreement or incomplete coverage
leaves work outstanding, records both counts/block/indexing progress in Launch,
and posts the failed attempt. Retry delays are **1 minute, 5 minutes, then 15 minutes**
within the existing action window. No value is chosen or averaged to break a tie.
Artist accounting also verifies paid mints and redeemed subscriptions at the cutoff.

After a successful receipt, Research verifies exact mint events and the resulting
total; Pay Artist verifies the native transfer recipient and value. Both wait for
finalized, indexed settlement evidence before recording completion and releasing
the signer reservation. This can delay the next action beyond its 18:00 eligibility.
Indexing lag retains the exact signed intent; an unexpected delivered result blocks
for operator recovery instead of automatically sending another transfer.

Follow the repository's authorized [deployment procedure](deployment.md). Complete
AWS role/key provisioning and runtime configuration first, then deploy sequentially:

| Order | Deployment unit | What must be available before continuing |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Existing `dbMigrationsLoop` | Run with `db_schema_scope=full`; synchronize launch, signer, evidence, preparation/jobs, settings, funding and `transaction_scan_checkpoints` tables |
| 2 | Existing `transactionsLoop` service | The configured creator consumer completes normal discovery and bounded finalized scans, including empty blocks; inspect its durable coverage before enabling post-mint execution |
| 3 | New `dropForgeLaunchHandler` | Launch Lambda, queue/DLQ, alarms and shared Scheduler group |
| 4 | New `memesDistributionHandler` | Distribution Lambda, queue/DLQ and alarms; watchdogs use the group from step 3 |
| 5 | Existing `claimsBuilder` | Local shared-calendar season calculation for new claims |
| 6 | Existing `api` | Endpoints, targeted dispatch, mint-accounting evidence, local subscription coverage and mention resolution |
| 7 | Existing `subscriptionsDaily` | Local calendar forecasts and coverage reconciliation |
| 8 | Existing `helpBotReplyLoop` | Local next/current/specific-mint calendar answers |
| 9 | Frontend | Processing, Craft controls, execution/recovery and evidence display |

The `claimsBuilder`, `subscriptionsDaily` and `helpBotReplyLoop` entries above
apply the paired shared-calendar foundation; they are not reporting dependencies
for `@drops6529`. See [calendar maintenance](shared-memes-calendar.md) for retired
network settings and year-round timing coverage.

Apply the generated monitoring stack updates before enabling either workflow.
No additional existing reporting-consumer redeploy is required for the new
automation mentions; existing `@devs6529` subscription alerts are unchanged.
Apply monitoring artifacts generated from the same reviewed revision. Both handlers
must appear in the production/staging policy inventory without a recurring interval;
keep their handler DLQ alarms enabled when applying the shared monitoring updates.
Initially keep preparation and automation disabled. Both handlers have **no recurring
schedule**. Process and Finalize and Launch/Update Claim enqueue work immediately;
Launch establishes per-drop one-time phase/Research schedules. Short continuations
exist only while checkpoints, reports or receipts are outstanding. The
[scheduled groups](architecture.md#drop-forge-scheduled-groups) run in the gaps
between phases; there is no permanently running one-minute worker. Launch admission
checks that the remaining time fits its serial transaction/confirmation budget, so
clicking just before 17:40 is not sufficient merely because minting has not opened.

If the earlier loop services were ever deployed, disable/remove their scheduled
rules before enabling the new handlers. Drain and reconcile existing SQL jobs,
reports and signed transactions, then enqueue each outstanding job/claim into its
new queue using its ID and current dispatch revision/launch revision. An authorized
Launch Resume or metadata/manual/recovery request also queues its claim. Do not
reset job IDs, signer locks or airdrop progress to migrate them. Delete the retired
loop stacks only after verifying no in-flight invocation can still sign.

A request publishes its targeted message under the SQL lock before committing the
new dispatch revision. An early message retries; failed publication rolls back the
request. Each handler establishes a one-time two-minute watchdog before doing work.
It removes that watchdog only after normal completion or an acknowledged failure;
a killed invocation leaves a recovery wake. The new checkpoint is queued before the
current delivery is acknowledged. Future groups have independent schedules, so a
failed earlier group cannot remove their triggers. Completed one-time schedules
remove themselves. Paused/cancelled stale deliveries recheck state and cannot start
fresh transaction work; signed receipts continue reconciliation.

On a DLQ alarm, inspect the exact message and ledger, fix authorization/network/
configuration, then use SQS **Start DLQ redrive** to its original queue. Redrive does
not authorize repeating airdrops or releasing a nonce. Inspect both handler DLQs,
Lambda errors and Scheduler delivery metrics; never delete an uncertain transaction
record. Disabled flags retain queued deliveries for retry/DLQ instead of accepting
and discarding work.

For the observation rollout:

1. Configure and verify all IDs, IAM permissions, KMS binding and limits.
2. Enable preparation when ready to use EMMA Process and Finalize. Complete EMMA,
   then publish Craft.
3. Enable the environment capability and the hub's Automatic launch switch while **withholding on-chain creator-admin permission
   from the KMS wallet**, then click **Launch** before the mint window. Backend
   operator authorization is a separate requirement.
4. Continue normal manual Launch operations. Use the coordinated controls so hashes
   and exact airdrop categories are recorded. External transactions need their hashes
   supplied; total supply alone cannot prove recipient delivery.
5. Inspect Launch and the operations wave. Due actions report missing permission;
   already-completed work is skipped after confirmed evidence. Earlier ordinary
   readiness failures do not block later groups. Unsigned failed actions retry at
   most once per minute within their execution window and each actual failed attempt
   reports and tags `@drops6529`, so repeated alerts during observation are expected.

The permission check rejects new transaction preparation before signing or
broadcasting, so those permission failures do not spend gas. This validates timing,
reporting and manual-work reconciliation; it does **not** validate live KMS signing,
gas estimation, successful contract execution or exceptional transaction recovery.
Run a separately configured Sepolia exercise for those paths before live authority.
The observation flow is the normal worker without contract permission, not an
independent dry-run mode. EMMA preparation still performs real backend writes.

## 7. Grant live authority when ready

Fund the derived wallet with ETH on the selected chain for gas and any enabled artist payments. The hub's Top Up ETH flow can do this from a connected authorized wallet. The creator owner
then grants that address creator-admin permission through the existing admin controls.
`CLAIMS_ADMIN_WALLETS` only authorizes backend controls and cannot grant this authority.

Granting admin while automation is enabled is the live switch: eligible pending work
can execute on the next run. First reconcile the active drop's manual evidence and
outstanding transactions. Completed work is not repeated; expired execution windows
are not automatically replayed. Mint proceeds keep going to the configured receiver;
Automatic artist payment is separately opt-in and defaults Off. It runs with Research at 18:00 the following day, using the exact final accounting and configured payment cap.

Use Launch's Pause/recovery controls for operational intervention. Disabling flags
does not cancel signed transactions, and disabling both automation and recovery also
stops receipt reconciliation. Never release an uncertain nonce with a database reset.

An unavailable RPC receipt block defers reconciliation to a later invocation while
retaining the signed transaction and nonce reservation. A confirmed block-hash
mismatch still requires reorg investigation; unavailable RPC data alone does not
mean that the transaction disappeared or should be sent again with a fresh nonce.

## 8. Configure the Launch Automation panel

After the environment capability is enabled, the hub's Automatic launch and
Automatic artist payment settings both start Off. The settings are stored in SQL,
not Secrets Manager, so changing them takes effect without redeploying services.
The creator owner and `CLAIMS_ADMIN_WALLETS` can edit. Every Drop Forge administrator,
including distribution-list and ordinary on-chain admins, can read the panel and
use Top Up ETH. Changing contract admins remains owner-only on chain.

Keep the environment capability on when using the hub's Off switch: this lets accepted
Launch plans retain their one-time phase and 18:00 post-mint schedules and report
why each due action was skipped. Off prevents new execution while retaining
confirmation/recovery tracking. Deployment kill switches still stop their documented
worker paths; they are not a replacement for the operator-facing switch.

Configure `DROP_FORGE_MAX_ARTIST_PAYMENT_ETH` in the regional `prod/lambdas` secret
before enabling artist payment and refresh the API/launch handler configuration.
Choose a positive maximum for one artist payout; no value is invented by deployment.
If the cap is later removed, you can still turn launch execution or artist payment Off;
a new payment opt-in or re-enabling execution with payment enabled requires the cap.
Fund the KMS wallet for payouts plus gas. Mint proceeds still go to the separate
payment receiver. Verify the claim's payment details/designated payee and completed
subscription accounting. Research and optional Pay Artist are independent actions
eligible at 18:00 Europe/Athens the next day. Incomplete accounting or unindexed
mints defer payment rather than using a partial amount. Record manual Pay Artist
transaction hashes; a checked completion flag alone cannot authorize another payment.

No new Lambda, queue or GitHub variable is added for these controls. Schema sync
must include the new settings and funding entities before deploying the updated
API and launch handler. Top-ups use the connected wallet and are reported after
canonical confirmation, including tracked same-nonce replacements/cancellations.
Validate these new money-transfer paths on Sepolia before enabling production payouts.
