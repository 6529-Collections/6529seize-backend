# IPFS infrastructure and recovery

This directory owns a reproducible **new IPFS candidate**, its pinned runtime,
logical backups, restoration, and a dedicated gateway. It does not adopt or
change the currently serving production resources. Production mutations are
disabled in `environments/prod.json`. No workflow runs a deployment on push or PR.

## Ownership and layout

| File                                    | Responsibility                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `versions.json`, `build-kubo.sh`        | Pinned Kubo and S3 commits, verified Go toolchain and nginx package, bundled S3 binary, artifact checksums    |
| `infrastructure.py`                     | CloudFormation for retained/versioned storage, immutable EC2 candidates, and dedicated gateway DNS/CloudFront |
| `common.py`, `control.py`               | Environment/source/account checks, offline plans, explicit infrastructure and SSM operations                  |
| `bootstrap.sh`, `host.py`, `templates/` | Candidate-only installation, systemd/nginx/TLS configuration, verification, backup, restore                   |
| `safety.test.ts`, `rehearse.py`         | Offline safety contracts and real-binary loopback S3/HTTPS/recovery rehearsal                                 |
| `environments/prod.json`                | Non-secret inventory and a disabled production-change policy                                                  |

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

Backups collect a stable pin inventory and MFS root through RPC, pin that root,
and upload a checksummed private archive with node identity to versioned backup
storage. They never copy an open LevelDB or publish private configuration as a
GitHub artifact. Node identity is sensitive; only the host role and authorized
recovery operators should be able to read backup objects. The role cannot delete
backups or object versions. Retention and backup-MFS pins deliberately grow until
a separately reviewed retention/GC policy is introduced.

A logical backup **references content in its recorded block bucket**; it does not
duplicate the content. Restore re-pins the recorded direct/recursive pins and
reconstructs MFS, then checks the exact root and pin types. Re-pinning can read
every descendant and take substantial time on the production-sized datastore.
It is not a constant-time metadata restore. Modified UnixFS root attributes or
missing blocks cause verification to fail instead of claiming successful recovery.
The saved identity is retained for disaster recovery but not installed by the
candidate workflow, avoiding two live nodes with one identity.

Restoration requires an empty isolated candidate and matching content storage
and pinned runtime. A failed restore leaves that candidate unpublished; discard
it and create a fresh one. The original server and backups remain available.
Rollback of a published replacement means returning traffic to the prior server
after reconciling writes; it does not mean downgrading a migrated repository with
an older executable.

## Local and PR validation

```bash
./bin/6529 ci
./bin/6529 exec jest --config ops/ipfs/jest.config.cjs
python3 ops/ipfs/control.py validate
python3 ops/ipfs/infrastructure.py compute > /tmp/ipfs-compute.json
bash -n ops/ipfs/build-kubo.sh ops/ipfs/bootstrap.sh
```

`ipfs-ci.yml` builds on Ubuntu 24.04 amd64 and rehearses the **exact resulting
binary** against an in-memory loopback S3 fixture. It exercises multi-chunk data,
direct/recursive pins, MFS, restart persistence, a fresh independent identity,
restoration and its restart, nginx TLS, upload, range/HEAD, and restricted routes.
It never assumes AWS credentials or contacts live gateways. The fixture is not a
substitute for AWS IAM, EC2 reboot, Certbot, CloudFront, production-load, or online
P2P testing. Those require a later authorized staging release.

## One-time staging bootstrap

The initial access roles and mandatory runtime permissions boundary are also
defined in code. An existing authorized bootstrap operator renders `access` and
creates `seize-ipfs-staging-access` with `CAPABILITY_NAMED_IAM`, passing
`Environment=staging`, the existing `GitHubOidcProviderArn`, a dedicated
`HostedZoneId`/`DnsSuffix`, and the exact `GitHubRepositorySubject` prefix if the
repository uses immutable OIDC IDs. The subject always appends
`:environment:ipfs-staging`; it cannot select another repository or environment.
The stack returns the deployment/service role ARNs and `RuntimeBoundaryArn`.
Neither Actions nor any other IPFS stack can modify this access stack or boundary.
Review these policies and rehearse them in AWS before promotion; schema validation
does not establish that all service authorization paths work.

```bash
python3 ops/ipfs/infrastructure.py access > /tmp/ipfs-access.json
```

1. Create GitHub environment `ipfs-staging`, restricted to `1a-staging`. Reuse
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
   the instance's SSM/S3/ACME access during the staging rehearsal.
4. Set environment variables `IPFS_DEPLOY_ROLE_ARN`,
   `IPFS_CLOUDFORMATION_ROLE_ARN`, `IPFS_REGION`, `IPFS_ACCOUNT_ID`, and
   `IPFS_CONFIG` (JSON, **no credentials**). Their account/region must agree.

Configuration shape (replace all example values):

```json
{
  "environment": "staging",
  "accountId": "111111111111",
  "region": "us-east-1",
  "blocksBucket": "new-staging-blocks-bucket",
  "backupsBucket": "new-staging-backups-bucket",
  "artifactsBucket": "new-staging-artifacts-bucket",
  "originHost": "ipfs-origin-staging.example.com",
  "apiHost": "ipfs-api-staging.example.com",
  "gatewayHost": "ipfs-staging.example.com",
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

After the normal authorized merge into `1a-staging`, dispatch
`.github/workflows/ipfs-manage.yml` with environment `staging` and the exact
reviewed `expected_source_sha`. `main` is the only production source branch, but
production operations are currently disabled by policy before AWS authentication.
One concurrency group serializes all operations per environment; runs never
cancel each other. Inputs are passed as arguments or environment data, never
interpolated into shell source.

| Operation               | Effect                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `plan`                  | Offline template/parameter rendering; no AWS authentication or changes                                                   |
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

Suggested staging sequence: storage → compute → deploy → upload fixture content
→ backup → second compute slot → deploy → restore → verify → publish edge for
that verified slot. Check HTTPS/CORS, all public restricted routes, byte ranges,
CloudFront behavior, EC2 reboot persistence, alarms/notifications, and a rollback
drill. Attach the evidence to the promotion PR. No Lambda redeploy is required.

Published hosts are sealed locally and tagged active before DNS can point to
them. Deployment and restore refuse active hosts; backups and verification can
continue. Runtime changes use new candidates, not a restart of the serving node.
Re-running installation on a partially initialized candidate is intentionally
rejected; replace the candidate rather than guessing which state is safe to erase.

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
