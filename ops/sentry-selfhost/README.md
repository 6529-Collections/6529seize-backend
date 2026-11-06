# Self-hosted Sentry

Official [getsentry/self-hosted](https://github.com/getsentry/self-hosted) on one
EC2 instance in the `6529-monitoring` account, `us-east-1`, published at
`https://sentry.6529.io`. It replaces the sentry.io SaaS dependency. Projects,
DSNs and the frontend/backend migration are separate steps; this folder owns the
host and its edge.

The operational-monitoring stacks in `eu-west-1` (`../monitoring`) are
independent of this folder and are not changed by it.

## Layout

| Path | Purpose |
| --- | --- |
| `core.json` | Stack `sentry-selfhost-core`: VPC (one private and one public subnet, single-AZ NAT), instance, encrypted 200 GiB gp3 data volume, DLM daily snapshots (14 kept), Route 53 Resolver DNS Firewall and query log, CloudWatch alarms, SNS topic, SES domain identity and SMTP-only IAM user |
| `edge.json` | Stack `sentry-selfhost-edge`: ACM certificate, WAF web ACL, CloudFront distribution with a VPC origin to the private instance, Route 53 health check and alarms |
| `host/` | Scripts and config shipped to the instance through SSM Run Command |
| `scripts/` | Operator scripts run with monitoring-account credentials |

Both templates are hand-maintained CloudFormation JSON. Validate them with the
same pinned linter as `../monitoring`:

```sh
pipx run --spec cfn-lint==1.40.4 cfn-lint core.json edge.json
shellcheck -S warning host/*.sh scripts/*.sh
```

## Design

- **Host:** `r7i.xlarge` (4 vCPU, 32 GiB), the documented self-hosted
  recommendation. Ubuntu 24.04 LTS from a pinned AMI ID, IMDSv2 only with hop
  limit 1 (containers cannot reach instance credentials), no public IP, no SSH
  key; access is SSM Session Manager only. Termination protection is on.
- **Storage:** the root volume holds only the OS. `/srv` is the encrypted data
  volume: Docker's data root, the self-hosted checkout and its configuration,
  and an 8 GiB swap file. DLM takes a crash-consistent snapshot set of both
  volumes daily at 05:00 UTC and keeps 14. The data volume is snapshotted on
  stack deletion or replacement.
- **Sentry:** a pinned release in errors-only mode (`COMPOSE_PROFILES=errors-only`)
  with 90-day event retention. Configuration overrides live in
  `host/sentry.conf.overrides.py` and `host/config.overrides.yml`;
  `install-sentry.sh` appends them as marked blocks to the generated
  `sentry.conf.py` and `config.yml` and writes `.env.custom`.
- **No calls to Sentry the company:** `SENTRY_BEACON = False`,
  `SENTRY_AIR_GAP = True`, the installer runs with
  `--no-report-self-hosted-issues`, and the JS SDK asset download is left off.
  The VPC's DNS Firewall answers NXDOMAIN for `sentry.io`, `getsentry.net`,
  `sentry-cdn.com`, `sentry.dev` and their subdomains, every query is logged to
  `/sentry-selfhost/dns-queries` (90 days), and a blocked query raises the
  `BlockedDnsQueryAlarm`. `scripts/verify-no-phone-home.sh` prints the evidence.
- **Ingress:** CloudFront terminates TLS for `sentry.6529.io` and reaches the
  instance's port 9000 through a VPC origin; the security group admits only
  CloudFront's origin-facing managed prefix list (VPC origin traffic arrives
  from those ranges, not from the VPC CIDR) and the instance has no public
  address. Nothing is cached except `/_static/*`. Django trusts
  `CloudFront-Forwarded-Proto` for HTTPS detection because the bundled nginx
  always forwards `X-Forwarded-Proto: http`.
- **WAF** (per client IP, five-minute windows): 100 requests to `/auth/` and
  `/api/0/auth/`; 30,000 to event ingestion (`/api/<id>/envelope|store|security|…`),
  which is deliberately generous because the 6529.io tunnel aggregates many
  browsers behind a few server IPs; 3,000 to everything else. The AWS IP
  reputation list applies everywhere and the known-bad-inputs group applies to
  non-ingest paths. Per-DSN rate limits inside Sentry are the second layer for
  ingestion. Sentry's own login throttles are `auth.ip-rate-limit: 20` and
  `auth.user-rate-limit: 10`.
- **Accounts:** local accounts only, registration closed, join requests off,
  organization-wide 2FA required. The owner's superuser is created by `host/create-admin.sh`; its
  generated password is stored only in the SSM SecureString
  `/sentry-selfhost/admin/initial-password`. GitHub SSO would need a GitHub App
  created by a 6529-Collections organization admin and is not set up.
- **Mail:** SES domain identity `sentry.6529.io` (Easy DKIM, 2048-bit), sending
  as `sentry@sentry.6529.io` through the bundled SMTP container's SES relay.
  The account is in the SES sandbox, so recipients must be verified identities.
  The SMTP user may only send with that From address. Its access key is created
  by `scripts/rotate-ses-smtp-credentials.py` and stored only in SSM
  (`/sentry-selfhost/ses/smtp-username`, `/sentry-selfhost/ses/smtp-password`).
- **Alarms** go to SNS topic `sentry-selfhost-alarms`: system status check
  (also triggers EC2 recover), instance and attached-EBS status checks, memory
  above 90%, `/` above 85%, `/srv` above 80%, a blocked Sentry-company DNS
  query, the Route 53 HTTPS health check of `/_health/`, and CloudFront 5xx
  rate above 10%.
- **Tags:** every resource carries `Project=sentry-selfhost` and `Owner=6529`
  (template tags plus stack tags).

## Deploy

Use credentials for the monitoring account (for example the
`AWSControlTowerExecution` role assumed from the management account) and
`us-east-1`. Review every change set before executing it.

1. Core stack. Resolve the AMI once and pass it explicitly; a different AMI
   replaces the instance.

   ```sh
   aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
   aws cloudformation deploy --stack-name sentry-selfhost-core --template-file core.json \
     --capabilities CAPABILITY_IAM --no-execute-changeset \
     --parameter-overrides AmiId=<ami> AlarmEmail=<owner> SandboxRecipientEmail=<owner> \
     --tags Project=sentry-selfhost Owner=6529
   aws cloudformation update-termination-protection --stack-name sentry-selfhost-core --enable-termination-protection
   ```

   The alarm subscription and the SES recipient each send the recipient a
   confirmation email that must be accepted.

2. Host. Install the CloudWatch agent package, then run the host scripts:

   ```sh
   aws ssm send-command --instance-ids <id> --document-name AWS-ConfigureAWSPackage \
     --parameters action=Install,name=AmazonCloudWatchAgent
   export INSTANCE_ID=<id>
   scripts/run-on-host.sh host/bootstrap-host.sh DATA_VOLUME_ID=<vol>
   python scripts/rotate-ses-smtp-credentials.py <SmtpUserName output>
   scripts/run-on-host.sh host/install-sentry.sh SELF_HOSTED_VERSION=26.10.1 \
     SELF_HOSTED_COMMIT=192a826421decd7f8ce6673bb9a299737d0d6916 \
     URL_PREFIX=https://sentry.6529.io ADMIN_EMAIL=6529@6529.io \
     MAIL_FROM=sentry@sentry.6529.io MAIL_DOMAIN=sentry.6529.io AWS_REGION=us-east-1
   scripts/run-on-host.sh host/create-admin.sh ADMIN_EMAIL=6529@6529.io \
     PASSWORD_PARAMETER=/sentry-selfhost/admin/initial-password AWS_REGION=us-east-1
   scripts/run-on-host.sh host/configure-org.sh ORG_SLUG=seize-ff ORG_NAME=6529
   scripts/run-on-host.sh host/verify-host.sh
   ```

3. Edge stack. Certificate validation waits for its DNS record, which lives in
   the `6529.io` hosted zone in the management account. While the stack is
   creating, read the record from `aws acm describe-certificate` and UPSERT it
   there (see DNS changes below).

   ```sh
   aws cloudformation deploy --stack-name sentry-selfhost-edge --template-file edge.json \
     --no-execute-changeset --tags Project=sentry-selfhost Owner=6529
   aws cloudformation update-termination-protection --stack-name sentry-selfhost-edge --enable-termination-protection
   ```

4. DNS in the management account (below), then check
   `https://sentry.6529.io/_health/` and run `scripts/verify-no-phone-home.sh`.

## DNS changes (management account, zone `6529.io`)

All are plain Route 53 change batches; record each applied batch and its
inverse with the change ID.

| Record | Type | Value | Rollback |
| --- | --- | --- | --- |
| ACM validation name from the certificate | CNAME | ACM validation target | `DELETE` the same record after the certificate is deleted |
| `sentry.6529.io` | A and AAAA alias | edge stack `DistributionDomainName`, alias zone `Z2FDTNDATAQYW2` | `DELETE` both aliases (the name did not exist before) |
| three `<token>._domainkey.sentry.6529.io` | CNAME | `<token>.dkim.amazonses.com` (core stack outputs `DkimRecord1-3`) | `DELETE` the three records |

## Operate

- Shell: `aws ssm start-session --target <instance-id>`, then `sudo -i`.
  `sentry-compose` is `docker compose` with the right env files, run from
  `/srv/sentry/self-hosted`.
- Upgrades: read the [release notes and hard stops](https://develop.sentry.dev/self-hosted/releases/)
  first. Every hard stop between the current and target release must be
  installed in turn (26.10.1 was installed fresh, so the next hard stop after
  it applies). Take a manual snapshot, then re-run `install-sentry.sh` with the
  new tag and commit. Re-run `verify-host.sh` and `verify-no-phone-home.sh`.
- SES credential rotation: run `scripts/rotate-ses-smtp-credentials.py`, then
  re-run `install-sentry.sh` so `.env.custom` and the relay pick it up.
- Restore: create volumes from a DLM snapshot set, stop the instance, swap the
  `/srv` volume (or launch a replacement from the root snapshot), start, and
  check `verify-host.sh`. Postgres, ClickHouse and Kafka recover from a
  crash-consistent image.

## Rollback

| Change | Rollback |
| --- | --- |
| Edge stack | Remove the `sentry.6529.io` aliases first, disable termination protection, delete `sentry-selfhost-edge`, then delete the ACM validation CNAME |
| Core stack | Delete the edge stack first, disable termination protection and instance termination protection (`DisableApiTermination`), delete `sentry-selfhost-core`. The data volume is snapshotted on deletion, the DNS query log group is retained, and DLM snapshots must be deleted separately. Delete the DKIM CNAMEs |
| SSM parameters | `aws ssm delete-parameters` for `/sentry-selfhost/admin/initial-password` and `/sentry-selfhost/ses/*` |
| SES SMTP access key | `aws iam delete-access-key` on the stack's SMTP user (also removed with the core stack) |
| Sentry install or upgrade | Restore `/srv` from the DLM snapshot taken before the change |
