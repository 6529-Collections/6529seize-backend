# Drop Forge launch automation setup

This is the setup guide for EMMA Process and Finalize, Craft Launch/Update Claim,
scheduled launch actions, and reports mentioning `@drops6529`. Operational behavior,
phase times, manual evidence and transaction recovery are described in
[Drop Forge automated launch operations](drop-forge-auto-launch.md).

**Maintenance:** update this guide in the same change whenever configuration,
deployment roles, signing permissions, reporting access or rollout behavior changes.
Keep `.env.sample`, the workflow generator and the companion frontend aligned.
All values below are operator-supplied; never commit real credentials or private keys.

## 1. Choose the environment

| Deployment | Protected GitHub environment | AWS region | Ethereum chain |
| --- | --- | --- | --- |
| Staging | `staging` | `eu-west-1` | Explicitly configured; use Sepolia `11155111` for test launches |
| Production | `production` | `us-east-1` | Mainnet `1` for real Memes launches |

Use separate KMS keys, operational wallets, waves, profile configuration and spending
limits for each environment. A profile or wave UUID must belong to the application's
selected environment. Deploying to staging does not itself select Sepolia.

Runtime configuration is loaded from AWS Secrets Manager **`prod/lambdas` in the
function's region**, including for staging. The API, launch worker and preparation
worker must read compatible configuration. The loader caches it in each warm process;
follow the normal service restart/redeployment procedure when changing configuration.
Changing a secret is not proof that every running instance has adopted it.

Deployment role ARNs are a separate input: put them in the selected **GitHub
environment's Actions variables**, not only in runtime Secrets Manager.

## 2. Set up the wave and profiles

Create or choose a dedicated operations wave with chat enabled. Choose the profile
that should author reports and the profiles to notify on failures.

| Runtime setting | Required value |
| --- | --- |
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

Supply the same recipient setting to services that create drops/notifications;
deploy the consumers listed in the operations guide so parsing and delivery agree.
The old shortcut and its old configuration key are not aliases for the new name.

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

The API execution role needs `lambda:InvokeFunction` on the deployed
`dropForgeLaunchLoop` and `dropForgePreparationLoop` function ARNs. The preparation
role needs permission to invoke `dropForgePreparationLoop` itself. These permissions
make the immediate async wake work; the one-minute schedules also recover queued work.

The backend deployment role must have `iam:PassRole` for the **exact execution role
ARNs**, restricted to the Lambda service. Existing deployment policies that permit
only the shared `lambda-vpc-role` must be updated administratively before rollout.
Do not grant the deploy workflow permission to edit arbitrary IAM policies.

In GitHub repository settings, open **Environments**, choose `staging` or
`production`, and add these **environment variables**:

| GitHub environment variable | Value |
| --- | --- |
| `DROP_FORGE_WORKER_ROLE_ARN` | Dedicated launch execution role ARN |
| `DROP_FORGE_PREPARATION_ROLE_ARN` | Preparation execution role ARN |

The deployment job selects the protected environment automatically, validates the
role needed by the selected worker and exports it before Serverless deployment.
Missing/invalid roles fail before deployment; unrelated services do not need these
variables. Role ARNs are identifiers, not AWS access keys. The workflow continues
using its existing deployment authentication.

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
| --- | --- |
| `DROP_FORGE_CHAIN_ID` | Explicit `1` or `11155111`; default is Sepolia |
| `DROP_FORGE_CREATOR_CONTRACT` | Creator scope; existing Memes default on mainnet, required on Sepolia |
| `DROP_FORGE_LAZY_CLAIM_CONTRACT` | Lazy-claim proxy; existing proxy default; verify for the selected chain |
| `DROP_FORGE_PAYMENT_RECEIVER` | Mint proceeds receiver; existing default on mainnet, required on Sepolia |
| `ETHEREUM_RPC_URL` | Existing mainnet HTTP(S) RPC configuration |
| `ETHEREUM_SEPOLIA_RPC_URL` | Existing Sepolia HTTP(S) RPC configuration |
| `DROP_FORGE_MAX_FEE_PER_GAS_WEI` | Required positive maximum fee per gas, in wei |
| `DROP_FORGE_MAX_GAS_PER_TX` | Required positive transaction gas limit cap |
| `DROP_FORGE_MAX_TX_COST_ETH` | Required positive transaction cost cap, in ETH |
| `DROP_FORGE_CONFIRMATIONS` | Default 12; allowed 2–64 |
| `DROP_FORGE_CALENDAR_BASE_URL` | Calendar source; defaults to `https://6529.io`; choose the intended environment |
| `DROP_FORGE_AUTOMATION_ENABLED` | Default disabled; exact `true` enables scheduled launch work |
| `DROP_FORGE_PREPARATION_ENABLED` | Default disabled; exact `true` enables EMMA preparation/finalization |
| `DROP_FORGE_RECOVERY_ENABLED` | Default disabled; allows recovery/reconciliation while scheduled work is disabled |

Choose gas caps for the actual workload and network; there are no implicit spending
defaults. Keep contract addresses, receiver, chain and signer consistent between API
and worker and stable for each active ledger. Do not change them to work around a
stuck transaction.

The existing `JWT_SECRET` must match between API and preparation worker. EMMA uses
the clicking administrator's authorization, encrypted for the durable job. **No
EMMA service-account token or new encryption secret needs prepopulation.** Existing
EMMA endpoint configuration and the operator's upstream permissions still apply.

## 6. Deploy disabled, then observe without contract-admin permission

Follow the repository's authorized [deployment procedure](deployment.md). Deploy
entity sync before API, then both workers, then dependent frontend controls and the
reporting consumers/monitoring updates listed in the operations guide. Initially
keep preparation and automation disabled. Each worker definition creates its
one-minute EventBridge schedule; a separate manually created schedule is unnecessary.

For the observation rollout:

1. Configure and verify all IDs, IAM permissions, KMS binding and limits.
2. Enable preparation when ready to use EMMA Process and Finalize. Complete EMMA,
   then publish Craft.
3. Enable automation for Launch while **withholding on-chain creator-admin permission
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

Fund the derived wallet with ETH on the selected chain for gas. The creator owner
then grants that address creator-admin permission through the existing admin controls.
`CLAIMS_ADMIN_WALLETS` only authorizes backend controls and cannot grant this authority.

Granting admin while automation is enabled is the live switch: eligible pending work
can execute on the next run. First reconcile the active drop's manual evidence and
outstanding transactions. Completed work is not repeated; expired execution windows
are not automatically replayed. Mint proceeds keep going to the configured receiver;
Pay Artist remains manual and is outside this automation.

Use Launch's Pause/recovery controls for operational intervention. Disabling flags
does not cancel signed transactions, and disabling both automation and recovery also
stops receipt reconciliation. Never release an uncertain nonce with a database reset.
