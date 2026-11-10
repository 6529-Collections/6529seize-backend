# IPFS infrastructure and recovery

This directory owns a reproducible **new IPFS candidate**, its pinned runtime,
logical backups, restoration, and a dedicated gateway. It also provides a separate,
disabled **import-only adoption path** for the currently serving resources.
No resources have been imported or changed. Production mutations are
disabled in `environments/prod.json`. There is one shared IPFS deployment target,
`prod`; the application staging environment does not get a separate IPFS service.
No workflow runs a deployment on push or PR.

## Ownership and layout

| File                                        | Responsibility                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `cloudformation/access.yaml`                | OIDC deployment/service roles and runtime permissions boundary                                    |
| `cloudformation/storage.yaml`               | Retained private data buckets and separate S3/CloudFront access-log buckets                       |
| `cloudformation/compute.yaml`               | Immutable EC2 replacement candidate, security group, role, EIP and alarm                          |
| `cloudformation/edge.yaml`                  | Dedicated gateway CloudFront distribution and DNS                                                 |
| `cloudformation/adoption.yaml`              | Observed production bucket, instance, security group and complete shared CDN baseline             |
| `cloudformation/adoption-access.yaml`       | Separate OIDC/import roles with configuration-read and ownership-tag access                       |
| `adoption.py`, `environments/adoption.json` | Exact import identities, native-model fingerprints, import preparation/execution and drift checks |
| `versions.json`, `build-kubo.sh`            | Pinned Kubo/S3/Go/nginx versions, build and artifact checksums                                    |
| `common.py`, `control.py`                   | Source/account/target guards, YAML loading, offline plans and explicit AWS/SSM operations         |
| `requirements-control.txt`                  | Pinned PyYAML dependency for the GitHub runner/local controller only                              |
| `bootstrap.sh`, `host.py`, `templates/`     | EC2 installation, systemd/nginx/TLS configuration, verification, backup and restore               |
| `safety.test.ts`, `rehearse.py`             | Safety contracts and real-binary loopback S3/HTTPS/recovery rehearsal                             |
| `environments/prod.json`                    | Existing-resource inventory and disabled production-change policy                                 |

Edit the CloudFormation YAML files directly. They are the infrastructure
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

The data buckets and dedicated CloudFront log bucket send S3 request logs to a
separate encrypted, private S3 audit sink. The sink is not itself logged, avoiding
recursive delivery; its write policy accepts only the S3 logging service, this
account, and the storage stack's generated bucket namespace. CloudFront standard
logging uses its own private bucket with ACLs enabled as required by that API;
ACLs remain disabled on content, backup, artifact and S3 audit buckets. CloudFront
cookies are not logged. Both log buckets have 90-day current/noncurrent-version
expiration rules. Pass the storage stack's `CloudFrontLogsBucket` output as the
edge template's `LogsBucket` parameter. Validate actual delivery during rollout.

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
python3 -m pip install -r ops/ipfs/requirements-control.txt cfn-lint==1.60.0
./bin/6529 ci
./bin/6529 exec jest --config ops/ipfs/jest.config.cjs
python3 ops/ipfs/control.py validate
python3 ops/ipfs/adoption.py plan
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
copy `BlocksBucket`, `BackupsBucket`, and `ArtifactsBucket` into `IPFS_CONFIG`
before provisioning compute. Record `CloudFrontLogsBucket` for the edge
`LogsBucket` parameter; log buckets are not part of the host configuration.
The instance ID is required only for host operations or edge publication. Use an
explicit pinned Canonical Ubuntu 24.04 amd64 AMI with the standard SSM snap service.
The subnet needs outbound HTTPS and DNS access and a route to the internet;
automatic public IPv4 assignment is disabled, and an explicit EIP is assigned.
Only HTTPS is exposed; SSH, RPC and the raw gateway have no inbound rules.

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
`CertificateArn`, plus `LogsBucket` from the storage stack. All template parameters
are checked before AWS calls.

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

## Import the existing production resources (future authorized operation)

`adoption.yaml` describes the configuration observed in AWS on November 10, 2026.
It retains the existing `6529ipfs` bucket, EC2 instance, its exclusively used
security group, and the **entire shared CloudFront distribution**. The CDN baseline
includes all three origins/aliases, ordered cache behaviors, media function and
policy references, certificate, WAF and logging configuration. The dedicated
`edge.yaml` is never substituted for that shared distribution.

An import records CloudFormation ownership; it does not reinstall the daemon,
move content, enable bucket versioning, tighten the security group, or switch
traffic. The baseline deliberately preserves current settings, including the
unversioned bucket, legacy SSH/swarm rules and unencrypted root volume. New
candidate templates retain their stricter defaults. Hardening the live resources
requires a separately reviewed change after adoption.

The import manifest is evidence: exact resource IDs and hashes of the full native
Cloud Control read models after excluding the provider's read-only properties.
It does not generate YAML. The audit also checks every property declared in YAML,
so editing a descriptor cannot silently import a different desired configuration.
EC2 duplicate representations (`NetworkInterfaces`, `Volumes`, `SecurityGroups`)
remain covered by the native-model hash while the YAML uses the equivalent
top-level instance properties. Custom tags and cache-behavior order are checked;
AWS-owned stack tags and irrelevant SG-rule ordering are normalized.

The import does **not** take ownership of the shared `EC2SSMRole`, its policies,
VPC/subnets, volume as a separate resource, AMI, DNS records, edge functions,
referenced cache/response policies, certificates, WAF, or host files. Their
references are preserved. Cloud Control does not return write-only properties
such as some launch inputs; the fingerprint is not a backup of disk contents,
nginx/systemd/Kubo settings, credentials, or node identity. Capture those privately
and verify the logical recovery backup before a runtime migration.

Both `changesEnabled` and `adoptionEnabled` in `environments/prod.json` are false.
No adoption workflow has been dispatched and merging this PR executes nothing.
The existing `control.py` candidate path continues rejecting the live bucket,
server and production hostnames; adoption never lifts those runtime/traffic fences.

For a future explicitly authorized import:

1. With bootstrap authority, create `seize-ipfs-prod-adoption-access` from
   `adoption-access.yaml` with `CAPABILITY_NAMED_IAM`, the existing GitHub OIDC
   provider ARN and correct repository subject prefix. Do not broaden the normal
   deployment role. The new service role can read configuration and attach
   CloudFormation ownership tags; it cannot change service behavior. Neither role
   has SSM command, DNS change, S3 object write, EC2 modification, or CloudFront
   configuration-update/deletion permissions. The original shared-CDN deny remains
   intact in `access.yaml`.
2. Configure `IPFS_ADOPTION_ROLE_ARN` and `IPFS_ADOPTION_SERVICE_ROLE_ARN` from its
   outputs in the existing `ipfs-prod` GitHub environment restricted to `main`.
   No `IPFS_CONFIG`, AWS keys, new IPFS environment, or new block bucket is needed.
3. Run **Adopt existing IPFS resources / audit** at the exact reviewed main SHA.
   It reads AWS and fails if configuration or identities differ from the reviewed
   baseline, or another live instance uses the source security group. This audit
   is available while mutation switches are disabled. It prints only public
   identifiers/check results, never raw resource models or credentials.
4. If the baseline has drifted, stop. Inspect the changed AWS configuration in
   restricted tooling, edit the YAML directly to the intended unchanged baseline,
   and review the new native-model and template hashes in `adoption.json`. Do not
   merely replace a failed hash to bypass review. The offline `plan` command does
   not fetch AWS or regenerate descriptors.
5. In a separately approved change, enable both switches, then run **prepare**.
   It creates an `IMPORT` change set for exactly four retained resources and
   verifies its full action list, source/baseline binding and original template.
   It never executes it. Review the returned exact change-set ARN and AWS changes.
6. Run **execute** with the same source SHA and exact prepared ARN. It repeats the
   live audit immediately before execution, imports, enables stack termination
   protection, installs a deny-all resource-update stack policy, and requires exact
   ownership plus `IN_SYNC` drift for every imported resource. These are stack
   metadata protections; live resource properties remain unchanged.
7. Keep the adoption stack's import-only service role and update prohibition. Disable
   the adoption switch again after the one-time import. Run **verify** for later
   ownership/template/baseline/drift checks. Drift detection updates CloudFormation
   diagnostic metadata but cannot alter resource configuration.

Adoption shares `ipfs-manage-prod` concurrency with candidate management. An
interrupted **prepare** reconciles its deterministic source/baseline-bound change
set rather than creating another. An interrupted **execute** resumes the same ARN,
waits for completion, then reapplies protections and verification. A timeout is
not rollback. Failed/rolled-back imports, foreign pending changes, deleted stacks,
wrong roles and changed templates require operator investigation; the controller
never falls back to CREATE/UPDATE, deletion, or an automatically selected latest
change set. Import failure may leave stack metadata or partial ownership: inspect
restricted stack events before a new reviewed attempt. Do not delete retained data
or restart the serving host to resolve it.

Local tests cover failure/retry contracts; a read-only audit matched the real AWS
baseline. No real import, OIDC role bootstrap or AWS permission execution has been
tested, since that would require changing production/account state.

## Runtime and traffic handover remains a separate migration

Importing infrastructure does not yet make a runtime deployment safe. Production
traffic remains fenced. The planned stable front door is an AWS Application Load
Balancer with separate writer/gateway target groups. Before exposing that path,
implement and rehearse the legacy nginx bridge (including clients with cached
DNS), target health and request draining, and a final monotonic pin/MFS transfer
that preserves uploads accepted by the replacement. API upload calls include
synchronous requests; simply returning 503 while capturing metadata is insufficient.

Validate a production-size restoration with an independent identity and tightly
scoped read-only block access first. The initial backup can become stale while
uploads continue. After switching the writer and draining the old requests, the
final source snapshot must be merged without erasing the replacement's new pins;
rollback must reconcile those new writes in the reverse direction. Keep the old
host and versioned backups until recovery and rollback evidence is complete.
Canonical DNS records need a separately guarded migration: Route53 record sets
are not supported by this import path. No ALB, bridge, canonical DNS update,
live-bucket candidate write access, or writer switch is provisioned by adoption.

This separation lets CloudFormation first record today's deployment without
changing its behavior. A later reviewed handover controller can manage runtime
replacements after the writer/draining protocol has been validated.

References: [CloudFormation resource import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/import-resources-manually.html),
[Systems Manager Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html),
[GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[pinned S3 plugin configuration](https://github.com/ipfs/go-ds-s3/blob/e4823540f59b71ce7969213faed4608c237a7296/plugin/s3ds.go).
