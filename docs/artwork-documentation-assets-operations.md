# Artwork documentation archive operations

This release stores artist working records in MySQL and originals in a dedicated
private S3 bucket. It does not mint, publish to IPFS/Arweave, or make a preservation
guarantee. Institutional retention and publication decisions remain separate.

## Deployment and enablement

Use the existing `Deploy a service` pipeline and coordinator release record.
Deploy this release's exact commit in this dependency order in each environment:

1. `artworkDocumentationStorage` creates the regional private, encrypted, versioned
   bucket, a GuardDuty plan limited to `originals/`, a scoped AWS Backup plan/vault
   and a separate private restore-test destination.
2. `dbMigrationsLoop` registers `ArtworkDocumentationAssetEntity` and its quota
   mutex entity, alongside the core documentation entities.
3. `artworkDocumentationProcessor` deploys the scheduled worker (one invocation
   per minute; reserved concurrency one; maximum invocation 900 seconds).
4. `api` exposes the authenticated upload/reference/download API.
5. Deploy the corresponding frontend only after backend verification.

The buckets are `6529-artwork-documentation-987989283142-eu-west-1` for staging and
`6529-artwork-documentation-987989283142-us-east-1` for production. They have no
CloudFront distribution or public origin permission. Bucket policy also denies
the CloudFront service principal object reads. An explicit region/bucket pair is
written to API environment configuration by the release workflow.

The release pipeline reads repository variables
`ARTWORK_DOCUMENTATION_ENABLED_STAGING`, `ARTWORK_DOCUMENTATION_ENABLED_PROD`,
`ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED_STAGING`, and
`ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED_PROD`. Explicit `true`/`false` values
change their corresponding runtime flag. An unset variable preserves the
existing runtime flag, or defaults to `false` for a first deployment. Invalid
values fail configuration selection. Keep self-service disabled during roster
piloting. Set the required variables and redeploy API to enable only after the
checks below; no secret or unrelated environment variable is replaced.

Before onboarding, the release coordinator verifies:

- Storage CloudFormation outputs include an `ACTIVE` malware plan. Check its
  current state with GuardDuty `get-malware-protection-plan`, not a historic
  deployment output alone. Both staging and production need their own plan.
- Bucket public access blocks, versioning, ownership, encryption and approved
  frontend CORS origins match the checked-in storage template.
- Browser-origin PUT accepts the checksum header and exposes ETag. GET/HEAD are
  CORS-enabled only for approved origins; authorization is still a short-lived
  presigned request. CORS is not an access grant.
- A small valid upload reaches `ready`, includes its server SHA-256, and downloads
  as identical bytes. A general reviewer receives only a stripped preview, while
  original download requires archival or rights-evidence access as applicable.
- An EICAR test file placed directly by an authorized operator in a **staging
  test upload** is quarantined by the actual GuardDuty plan; do not give artists
  malware test fixtures or run malware tests in production records.
- A multipart large-file test exercises accepted-part recovery, a short final
  part and changed-file rejection; the API never handles full original bytes.
- Processor Lambda error alarm is visible to the operational monitoring owner.
  The `6529/ArtworkDocumentation` namespace also emits pending count, oldest
  processing age, failures/quarantines in the last hour and maximum context quota
  use. Failure and one-hour queue-delay alarms complement the Lambda error alarm;
  normal handled failures do not appear as Lambda invocation errors. Inspect
  these metrics and failure codes before enabling the pilot. Metrics contain no
  artist identity, filename, object key or instrument text.

The current AWS limit is 100 GB per scanned S3 object; the product limit is 4 GiB.
See [AWS scan quotas](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-quotas-guardduty.html)
and [GuardDuty role requirements](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-iam-policy-prerequisite.html).
The existing attachments subsystem uses the same GuardDuty scan-result contract,
but artwork storage, original identity and processing are independent.

## Upload and worker recovery

Each upload has one asset ID, unique object key, request idempotency key and
reservation. A context mutex serializes quota checks. Reservations count against
20 GiB while uploading, processing or retained; at most five active uploads and
100 retained/unexpired assets are allowed. Repeated start requests do not reserve
twice. Quotas are server constants in `ARTWORK_UPLOAD_POLICY`; raising them
requires a reviewed capacity change, not a request parameter.

Parts are 16 MiB, up to three signed at once. Each signed PUT binds the expected
length and SHA-256 checksum. Once a checksum is issued, that part number cannot
be reused for changed bytes. Received parts are read from S3; finalization checks
their ordered ETags, hashes and actual lengths, including the short final part.
A response lost after S3 completes can recover using the unique object identity
and immutable version. The worker streams the version's full byte count and
SHA-256 with bounded buffers. Unsupported vendor RAW metadata is reported as
unsupported; a digest is fixity evidence, not an authorship certificate.

The durable queue lives in `artwork_documentation_assets`. A SQL row lease
prevents duplicate processing; expired leases permit recovery after a crash.
Only a real version-specific `NO_THREATS_FOUND` GuardDuty tag permits byte
inspection. Missing tags stay pending; unsupported/threat results quarantine,
scan failures fail, and repeated transient failures terminate honestly. Never
manually set a ready state or write a successful malware tag to bypass checks.

The worker keeps at most a 64 KiB inspection prefix in memory. Only ordinary
image files no larger than 256 MiB are streamed to a unique temporary file for
preview generation. Sharp has a 100-megapixel input limit, a 25-second timeout
and 1600-pixel output bounds. Metadata is stripped from the derivative; originals
are unchanged. Larger or unsupported files receive an honest file card and any
safely detected dimensions. Plain text/XMP are validated as UTF-8; XMP external
entity declarations are rejected and XML is never executed or fetched. Documents
and unsupported formats download as octet-stream attachments, never same-origin
active content.

If a worker outage leaves processing records stale, restore the worker and
scanner permissions first; leases retry automatically. A failed/quarantined
unreferenced upload can be cancelled and replaced. An artist's confirmed record
must reference a ready original; never silently substitute bytes.

## Retention, restore and deletion

Incomplete sessions expire at 24 hours; S3 also aborts incomplete multipart
uploads after one day. The worker removes expired unreferenced originals.
Ready unattached assets expire after seven days, as disclosed in the UI.
An asset attached to a draft or any confirmed revision gets a retained flag in
the same database transaction; replacement/detachment does not delete that
previous original. The cleanup worker locks the same asset row before deletion,
so a concurrent reference cannot race cleanup. Preview noncurrent versions have
a seven-day lifecycle rule. There is no blanket original-object expiry rule.

The storage stack adds a separate AWS Backup vault and daily 03:00 UTC backup
with a 35-day operational recovery window. Its resource selection is the one
archive bucket ARN; it does not enroll unrelated buckets. The custom backup role
can read only that bucket's bytes. The restore role can write only to the separate
private `6529-artwork-restore-987989283142-<region>` bucket and cannot overwrite
the live archive. Restore copies expire after seven days. Both buckets use
BucketOwnerEnforced ownership; ACL backup/restore is disabled, object tags are
preserved, and the restored bytes use SSE-S3. Backup vault deletion is retained;
there is no irreversible vault-lock configuration in this release.

Daily backups imply up to a day of recovery-point lag; this is not continuous
PITR or cross-region disaster recovery. Thirty-five days is the operational
backup window, not a promise of public or institutional artwork retention.
Confirm the account's S3 Backup opt-in with `aws backup describe-region-settings`
in both regions before deployment. It was already enabled in both regions during
implementation; no regional preference change was made. If that changes, the
coordinator must review existing broad resource selections before enabling it.
See [AWS S3 backup prerequisites](https://docs.aws.amazon.com/aws-backup/latest/devguide/s3-backups.html).

The backend operations owner includes these two tables and all core record
tables in existing MySQL backups. Before onboarding, restore one synthetic
confirmed revision into an isolated test database and compare the canonical
snapshot/hash. Also perform a real S3 backup/restore drill using the referenced
synthetic ready asset (at most 10 MiB). In PowerShell 7:

```powershell
$drill = @{
  AssetId = '<synthetic-ready-asset-UUID>'
  ExpectedSha256 = '<SHA256-from-the-confirmed-revision-manifest>'
  StateDirectory = '<absolute-path-to-private-operator-state-directory>'
}
./scripts/artwork-archive-restore-drill.ps1 @drill -Phase StartBackup
./scripts/artwork-archive-restore-drill.ps1 @drill -Phase BackupStatus
# When BackupStatus reports COMPLETED:
./scripts/artwork-archive-restore-drill.ps1 @drill -Phase StartRestore
./scripts/artwork-archive-restore-drill.ps1 @drill -Phase RestoreStatus
# When RestoreStatus reports COMPLETED:
./scripts/artwork-archive-restore-drill.ps1 @drill -Phase Verify
```

The helper is staging-only, checks the account and stack destinations, starts a
seven-day on-demand backup, restores only the named object into the isolated
destination, and requires matching byte size and SHA-256 before recording
success. Keep its state file and the isolated database restore result as release
evidence. Status commands return immediately; wait between checks in the
coordinator. A completed AWS job alone is insufficient because a restore with no
matching objects can still report completed. See
[AWS item restore behavior](https://docs.aws.amazon.com/aws-backup/latest/devguide/restoring-s3.html).

An operational recovery may create new S3 version IDs. After comparing every
restored object's bytes against its immutable manifest, an authorized operator
records a storage-locator recovery mapping (old/new bucket and version) before
reconnecting records; do not change the artist's confirmed payload or infer
that an old version ID exists in the restore destination. Do not claim successful
backup/restore until both the database and object drills have actual evidence.

Artist-facing permanent deletion is outside this first UI. Existing support
requests go to the authorized backend operations owner. The operator identifies
all current and historical references, obtains the required institutional
decision, applies a disclosure tombstone without secretly editing an immutable
record, removes applicable original versions and derivatives, and records the
backup-expiry handling under the adopted policy. Keep signed URLs, instrument
filenames, raw rights text and contact data out of tickets and operational logs.
Signed downloads can remain usable for their remaining five-minute lifetime
after access revocation; do not promise instantaneous recall.
