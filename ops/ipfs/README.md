# IPFS infrastructure and recovery

This directory owns a reproducible **new IPFS candidate**, its pinned runtime,
logical backups, restoration, and a dedicated gateway. It does not adopt or
change the currently serving production resources. Production mutations are
disabled in `environments/prod.json`. There is one shared IPFS deployment target,
`prod`; the application staging environment does not get a separate IPFS service.
No workflow runs a deployment on push or PR.

## Ownership and layout

| File                                    | Responsibility                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cloudformation/access.yaml`            | OIDC deployment/service roles and runtime permissions boundary                            |
| `cloudformation/storage.yaml`           | Retained, versioned private block/backup/artifact buckets                                 |
| `cloudformation/compute.yaml`           | Immutable EC2 replacement candidate, security group, role, EIP and alarm                  |
| `cloudformation/edge.yaml`              | Dedicated gateway CloudFront distribution and DNS                                         |
| `versions.json`, `build-kubo.sh`        | Pinned Kubo/S3/Go/nginx versions, build and artifact checksums                            |
| `common.py`, `control.py`               | Source/account/target guards, YAML loading, offline plans and explicit AWS/SSM operations |
| `requirements-control.txt`              | Pinned PyYAML dependency for the GitHub runner/local controller only                      |
| `bootstrap.sh`, `host.py`, `templates/` | EC2 installation, systemd/nginx/TLS configuration, verification, backup and restore       |
| `safety.test.ts`, `rehearse.py`         | Safety contracts and real-binary loopback S3/HTTPS/recovery rehearsal                     |
| `environments/prod.json`                | Existing-resource inventory and disabled production-change policy                         |

Edit the four CloudFormation YAML files directly. They are the infrastructure
source of truth; there is no template generator. The controller reads their
parameter definitions and submits the selected YAML file unchanged to AWS
CloudFormation. The long-form `Ref`/`Fn::Sub`/`Fn::GetAtt` mappings are standard
CloudFormation syntax.

The JSON files are inputs: `versions.json` pins software, and
`environments/prod.json` records policy/inventory. Actual deployment settings
come from `IPFS_CONFIG` and explicit workflow parameters described below. The
EC2 runtime does not need PyYAML or the infrastructure templates.

There are no Lambda, API-contract, database, or frontend changes. Existing app
endpoints remain unchanged. IPFS is an independent deployment unit, not a Lambda
choice in `src/config/deploy-services.json`.

## State and recovery guarantees

The server runs Kubo with S3 blocks and local LevelDB metadata. Kubo's RPC and
gateway listeners are loopback-only. nginx exposes only the upload RPC and
health route on the API hostname; other RPCs return 403. Gateway traffic uses
a separate hostname. Certbot renews origin/API certificates with DNS challenges;
the runtime role can change only their ACME TXT records. The CloudFront viewer
certificate is an existing ACM certificate in `us-east-1`.

The block, backup, and artifact buckets are private, encrypted, versioned, and
retained on stack deletion/replacement. The runtime role explicitly denies block
deletion. Automatic garbage collection is never enabled. Retention protects data;
it is not a substitute for recovery drills or an independent disaster-recovery
copy of the S3 block store.

Backups flush MFS, collect a stable pin inventory and MFS root through RPC, pin that root,
and upload a checksummed private archive with node identity to versioned backup
storage. They never copy an open LevelDB or publish private configuration as a
GitHub artifact. Node identity is sensitive; only the host role and authorized
recovery operators should be able to read backup objects. The role cannot delete
backups or object versions. The archive includes the retained root pin and pin
names; restoration checks the exact recorded direct/recursive pin set. Retention
and backup-MFS pins deliberately grow until a separately reviewed retention/GC
policy is introduced. Root-private `backup-attempts/` records are written before
pinning and updated after upload. A pending record after failure/termination
identifies the root and attempted object key for reconciliation. Do not blindly
unpin it: another writer may have independently pinned the same immutable root.

These are observed reference snapshots, not a write-fenced transaction across
concurrent pin and MFS changes. Uploads continue during capture. Included immutable
roots are independently recoverable from retained storage, but a backup is not a
cutover boundary for all writes completed afterward. Production migration still
requires the separately validated writer fence and final state-transfer protocol
described below.

A logical backup **references content in its recorded block bucket**; it does not
duplicate the content. Restore re-pins the recorded direct/recursive pins and
reconstructs MFS, then checks the exact root and pin types. Re-pinning can read
every descendant and take substantial time on the production-sized datastore.
It is not a constant-time metadata restore. Modified UnixFS root attributes or
missing blocks cause verification to fail instead of claiming successful recovery.
The saved identity is retained for disaster recovery but not installed by the
candidate workflow, avoiding two live nodes with one identity.

Restoration starts on an empty isolated candidate and matching content storage
and pinned runtime. Kubo's bootstrap empty-directory pin is allowed, and its
content is materialized in S3 before use. A durable root-private restore journal
binds retries to one backup key, object version, checksum, and candidate identity.
Retries skip verified existing pins and MFS entries and resume incomplete copies;
conflicting entries, foreign pins, or a different backup/identity are rejected.
An incomplete restore cannot pass verification or be published. A successful
restore can be repeated against the same unchanged candidate. If conflicting
state needs to be replaced, create a fresh candidate; no restore path erases it.
The original server and backups remain available throughout.
Rollback of a published replacement means returning traffic to the prior server
after reconciling writes; it does not mean downgrading a migrated repository with
an older executable.

## Local and PR validation

```bash
python3 -m venv /tmp/ipfs-control-tools
source /tmp/ipfs-control-tools/bin/activate
python3 -m pip install -r ops/ipfs/requirements-control.txt cfn-lint==1.46.0
./bin/6529 ci
./bin/6529 exec jest --config ops/ipfs/jest.config.cjs
python3 ops/ipfs/control.py validate
cfn-lint ops/ipfs/cloudformation/*.yaml
bash -n ops/ipfs/build-kubo.sh
bash -n ops/ipfs/bootstrap.sh
```

`ipfs-ci.yml` builds on Ubuntu 24.04 amd64 and rehearses the **exact resulting
binary** against an in-memory loopback S3 fixture. It exercises multi-chunk data,
direct/recursive pins, MFS, restart persistence, a fresh independent identity,
restoration and its restart, nginx TLS, upload, range/HEAD, and restricted routes.
It never assumes AWS credentials or contacts live gateways. The fixture is not a
substitute for AWS IAM, EC2 reboot, Certbot, CloudFront, production-load, or online
P2P testing. Those require explicitly authorized validation of an unpublished
replacement candidate before production traffic handover. Local/CI fixtures
create no AWS environment.

The rehearsal also injects an interruption after one MFS subtree has been copied,
then retries and repeats the completed restore. Every explicit fixture pin's root
block is retrieved, including the bootstrap directory and retained backup root.

## One-time production access bootstrap (future authorized rollout)

The initial access roles and mandatory runtime permissions boundary are also
defined in `cloudformation/access.yaml`. An existing authorized bootstrap operator
submits that file directly to CloudFormation to create `seize-ipfs-prod-access` with `CAPABILITY_NAMED_IAM`, passing
`Environment=prod`, the existing `GitHubOidcProviderArn`, a dedicated
`HostedZoneId`/`DnsSuffix`, and the exact `GitHubRepositorySubject` prefix if the
repository uses immutable OIDC IDs. The subject always appends
`:environment:ipfs-prod`; it cannot select another repository or environment.
The stack returns the deployment/service role ARNs and `RuntimeBoundaryArn`.
Neither Actions nor any other IPFS stack can modify this access stack or boundary.
This bootstrap requires separate explicit authorization; it has not been executed.
Review the policies and validate their AWS authorization paths before serving
traffic; schema validation alone does not establish that they work.

1. Create GitHub environment `ipfs-prod`, restricted to `main`. Reuse
   the existing GitHub OIDC provider; do not configure long-lived AWS access keys.
2. Review and create the access stack above with existing bootstrap authority.
   Its controller policy scopes stack mutations, SSM targets, artifact writes,
   and passing the CloudFormation service role. Its service role cannot create
   an unbounded runtime role or modify the access stack. Global describe/list
   permissions are read-only. The shared production distribution is explicitly
   denied mutation, even through a tag change.
3. Verify the dedicated DNS suffix, runtime permissions boundary, and generated
   bucket namespace against the actual account. The service role can create
   new EC2 and CloudFront resources; validate those AWS authorization paths and
   the replacement instance's SSM/S3/ACME access before any traffic handover.
4. Set environment variables `IPFS_DEPLOY_ROLE_ARN`,
   `IPFS_CLOUDFORMATION_ROLE_ARN`, `IPFS_REGION`, `IPFS_ACCOUNT_ID`, and
   `IPFS_CONFIG` (JSON, **no credentials**). Their account/region must agree.

Configuration shape (replace all example values):

```json
{
  "environment": "prod",
  "accountId": "111111111111",
  "region": "us-east-1",
  "blocksBucket": "new-prod-blocks-bucket",
  "backupsBucket": "new-prod-backups-bucket",
  "artifactsBucket": "new-prod-artifacts-bucket",
  "originHost": "ipfs-origin-candidate.example.com",
  "apiHost": "ipfs-api-candidate.example.com",
  "gatewayHost": "ipfs-candidate.example.com",
  "hostedZoneId": "Z123456789",
  "acmeEmail": "operations@example.com",
  "instanceId": "i-11111111111111111"
}
```

For the initial storage stack, bucket names in config can be proposed placeholders;
the template generates new globally unique names. After its successful creation,
copy the three stack outputs into `IPFS_CONFIG` before provisioning compute.
The instance ID is required only for host operations or edge publication. Use an
explicit pinned Canonical Ubuntu 24.04 amd64 AMI with the standard SSM snap service.
The subnet needs outbound HTTPS and DNS access and a route to the internet;
an EIP is assigned without exposing SSH, RPC, or the raw gateway.

## Explicit Actions operations

After an explicitly authorized merge into `main`, dispatch
`.github/workflows/ipfs-manage.yml` with the exact reviewed `expected_source_sha`.
There is no deployment-environment selector: the workflow uses only `ipfs-prod`,
and the controller and all templates accept only `prod`. Mutations remain disabled
by the checked-in policy before AWS authentication. Enabling them and adopting the
existing resources require a separately reviewed rollout; changing the policy
alone does not remove the existing-resource fences below.
One concurrency group serializes all IPFS operations; runs never cancel each other.
Inputs are passed as arguments or environment data, never interpolated into shell
source.

| Operation               | Effect                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `plan`                  | Read the checked-in YAML and show parameters; no AWS authentication or changes                                           |
| `apply`, kind `storage` | New retained/versioned storage stack; updates reject resource removal/replacement                                        |
| `apply`, kind `compute` | New immutable candidate slot; refuses an existing slot                                                                   |
| `deploy`                | Build/rehearse/package/upload a release, fetch its exact S3 version and verify checksums, install on an unused candidate |
| `backup`                | Logical metadata/identity archive to private versioned storage; returns only key/version/count                           |
| `restore`               | Explicit `backup_key` and recorded `backup_version` into an empty candidate pointing to the recorded block bucket        |
| `verify`                | Artifact/runtime/datastore checks and real loopback upload/pin/read verification                                         |
| `apply`, kind `edge`    | Verify and seal the candidate before publishing **new dedicated** DNS/CloudFront; requires its exact public IP           |

Compute parameters are `VpcId`, `SubnetId`, `ImageId`, `IngressCidr`,
`RuntimeBoundaryArn` from the access stack, and optional `InstanceType`.
Data settings and ACME hostnames come from config and cannot be
overridden by workflow parameters. Edge parameters are `PublicIp` and
`CertificateArn`. All template parameters are checked before AWS calls.

For a future authorized production rollout, provision access/storage as needed,
create an unpublished replacement compute slot, deploy, restore the recorded state,
and verify it before any traffic handover. A temporary replacement server is part
of the production deployment procedure, not a separate staging IPFS environment.
Check HTTPS/CORS, public restricted routes, byte ranges, CloudFront behavior, reboot
persistence, alarms/notifications, and rollback. Existing data adoption and the
writer/traffic handover still require the implementation described below. Do not
publish an isolated empty bucket as a replacement for production content. Attach
validation evidence to the rollout PR. No Lambda redeploy is required.

Published hosts are sealed locally and tagged active before DNS can point to
them. Deployment and restore refuse active hosts; backups and verification can
continue. Runtime changes use new candidates, not a restart of the serving node.
Re-running installation on a partially initialized candidate is intentionally
rejected; replace the candidate rather than guessing which state is safe to erase.

SSM success must include a valid versioned operation receipt. A missing backup
key/version, incomplete verification result, or malformed receipt fails the run
even when SSM reports Success. Trailing log messages do not hide the receipt;
only the operation's approved public fields are returned to GitHub.

### Interrupted controllers and certificate issuance

A controller timeout does not mean AWS or an SSM command rolled back. Inspect the
recorded command ID and CloudFormation stack events/status before retrying. Wait
for any in-progress stack operation to reach a terminal state; do not cancel
another operator's work or delete a retained volume/bucket to unblock it. Use the
stack outputs and read-only diagnostics to reconcile completed work. A failed
restore can resume with the same key/version and journal; a different backup
requires a fresh candidate. Failed infrastructure creation or installation uses
a new immutable slot, with retained resources inventoried before later cleanup.

The native rehearsal uses self-signed loopback TLS and consumes no ACME quota.
For repeated DNS/ACME troubleshooting, first use the certificate authority's test
endpoint (`certbot --staging`) on disposable dedicated hostnames. This is a TLS
issuance test, not a separate IPFS deployment environment. Those certificates
are not publicly trusted and must not be published behind CloudFront. Normal
installation requests a publicly trusted certificate and stops on issuance
failure; it does not repeatedly retry ACME. Recreating candidates can hit both
duplicate-identifier and registered-domain limits. Inspect the restricted Certbot
diagnostics and honor the CA's retry time before another real issuance attempt.
See [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/).

## Production adoption and traffic handover

This is **not** authorization to adopt production. The checked-in production
inventory identifies the existing server, bucket and shared distribution. The
controller rejects those targets as well as existing production DNS names, even
when callers supply their IDs directly. Merely merging this PR starts nothing.

Before removing those fences in a future reviewed release:

1. Capture the live nginx/systemd/Kubo settings with secrets and identity removed
   from Git; compare them with the desired templates. Verify backups and recovery
   access. Account for uploads since every backup.
2. Model/import supported existing persistent resources with retain policies;
   use an import-only change set and drift checks before updates. Imports do not
   prove that template values match reality. Do not recreate the production bucket.
3. Preserve the **entire shared distribution**: `media.6529.io`, its `/arweave/*`
   and `/s3/*` behaviors/functions/policies, existing aliases, certificate and WAF.
   This directory's dedicated edge template cannot replace that distribution.
4. Rehearse the production-size restore with isolated identity and tightly scoped
   read-only access before any production content-write permissions are granted.
5. Implement and validate the traffic-handover contract: continue serving reads
   from a healthy node, durably hold/retry uploads during the final state capture,
   transfer all completed writes/pins/MFS, retain one authoritative writer, then
   switch both gateway and API traffic and verify every pin and new uploads.
   DNS propagation and CloudFront caching must be accounted for. Two unsynchronized
   writable daemons are not a safe deployment strategy.
6. Only after that rehearsal, enable the reviewed production adoption path and
   its narrowly scoped OIDC/IAM permissions. Retain the old host and backups until
   rollback and recovery evidence is complete.

The current single-host setup cannot provide zero downtime merely by restarting
Kubo. Rather than claiming otherwise, these workflows fail closed on active-host
updates and do not automate production traffic handover. Adding production adoption
and that validated handover is a prerequisite to a future production release.

References: [CloudFormation resource import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/import-resources-manually.html),
[Systems Manager Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html),
[GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[pinned S3 plugin configuration](https://github.com/ipfs/go-ds-s3/blob/e4823540f59b71ce7969213faed4608c237a7296/plugin/s3ds.go).
