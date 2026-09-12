#Requires -Version 7.0
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('StartBackup', 'BackupStatus', 'StartRestore', 'RestoreStatus', 'Verify')]
  [string]$Phase,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$AssetId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [string]$ExpectedSha256,
  [Parameter(Mandatory = $true)]
  [string]$StateDirectory
)

$ErrorActionPreference = 'Stop'
if (-not [Guid]::TryParseExact($AssetId, 'D', [ref]([Guid]::Empty))) { throw 'AssetId must be a canonical UUID.' }
$region = 'eu-west-1'
$archiveBucket = '6529-artwork-documentation-987989283142-eu-west-1'
$restoreBucket = '6529-artwork-restore-987989283142-eu-west-1'
$objectKey = "originals/$AssetId"
$stateRoot = [System.IO.Path]::GetFullPath($StateDirectory)
[System.IO.Directory]::CreateDirectory($stateRoot) | Out-Null
$statePath = Join-Path $stateRoot "artwork-restore-$AssetId.json"

function Invoke-ArchiveAws([string[]]$Arguments) {
  $output = & aws @Arguments --region $region --no-cli-pager --output json
  if ($LASTEXITCODE -ne 0) { throw 'AWS archive drill command failed.' }
  if ($output) { return ($output -join "`n") | ConvertFrom-Json }
}

function Save-DrillState($State) {
  $State | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding utf8
}

$identity = Invoke-ArchiveAws -Arguments @('sts', 'get-caller-identity')
if ($identity.Account -ne '987989283142') { throw 'This drill only targets the configured staging account.' }
$stack = Invoke-ArchiveAws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', 'artworkDocumentationStorage-staging')
$outputs = @{}
foreach ($entry in $stack.Stacks[0].Outputs) { $outputs[$entry.OutputKey] = $entry.OutputValue }
if ($outputs['ArtworkArchiveBucketName'] -ne $archiveBucket -or $outputs['ArtworkRestoreBucketName'] -ne $restoreBucket) { throw 'Unexpected archive or restore destination.' }

if ($Phase -eq 'StartBackup') {
  if (Test-Path -LiteralPath $statePath) { throw 'A drill for this asset already exists; use its status/restore phases.' }
  $head = Invoke-ArchiveAws -Arguments @('s3api', 'head-object', '--bucket', $archiveBucket, '--key', $objectKey)
  if ($head.ContentLength -gt 10485760) { throw 'Use a synthetic staging fixture of at most 10MiB for the restore drill.' }
  if ($head.Metadata.'artwork-asset-id' -ne $AssetId -or -not $head.VersionId) { throw 'Object identity or immutable version is missing.' }
  $result = Invoke-ArchiveAws -Arguments @('backup', 'start-backup-job', '--backup-vault-name', $outputs['ArtworkBackupVaultName'], '--resource-arn', "arn:aws:s3:::$archiveBucket", '--iam-role-arn', $outputs['ArtworkBackupRoleArn'], '--idempotency-token', "artwork-drill-$AssetId", '--lifecycle', 'DeleteAfterDays=7', '--backup-options', 'BackupACLs=disabled,BackupObjectTags=enabled')
  $state = @{ asset_id = $AssetId; expected_sha256 = $ExpectedSha256.ToLowerInvariant(); original_version = $head.VersionId; original_size = $head.ContentLength; backup_job_id = $result.BackupJobId; started_at = [DateTime]::UtcNow.ToString('o') }
  Save-DrillState $state
  $result | Select-Object BackupJobId, RecoveryPointArn | ConvertTo-Json
  exit 0
}

if (-not (Test-Path -LiteralPath $statePath)) { throw 'StartBackup must create the drill state first.' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable
if ($state.asset_id -ne $AssetId -or $state.expected_sha256 -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Drill identity or expected confirmed digest changed.' }

if ($Phase -eq 'BackupStatus' -or $Phase -eq 'StartRestore') {
  $backup = Invoke-ArchiveAws -Arguments @('backup', 'describe-backup-job', '--backup-job-id', $state.backup_job_id)
  if ($Phase -eq 'BackupStatus') { $backup | Select-Object BackupJobId, State, RecoveryPointArn, StatusMessage | ConvertTo-Json; exit 0 }
  if ($backup.State -ne 'COMPLETED') { throw "Backup must complete before restore; current state: $($backup.State)" }
  if ($state.restore_job_id) { throw 'Restore already started; use RestoreStatus or Verify.' }
  $metadata = @{ DestinationBucketName = $restoreBucket; RestoreACLs = 'false'; EncryptionType = 'SSE-S3'; ItemsToRestore = (@("s3://$archiveBucket/$objectKey") | ConvertTo-Json -Compress -AsArray); RestoreLatestVersionsUpTo = '1' }
  $metadataPath = Join-Path $stateRoot "artwork-restore-metadata-$AssetId.json"
  $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8
  $result = Invoke-ArchiveAws -Arguments @('backup', 'start-restore-job', '--recovery-point-arn', $backup.RecoveryPointArn, '--metadata', "file://$metadataPath", '--iam-role-arn', $outputs['ArtworkRestoreRoleArn'], '--resource-type', 'S3', '--idempotency-token', "artwork-restore-$AssetId")
  $state.recovery_point_arn = $backup.RecoveryPointArn
  $state.restore_job_id = $result.RestoreJobId
  Save-DrillState $state
  $result | ConvertTo-Json
  exit 0
}

if (-not $state.restore_job_id) { throw 'StartRestore must complete before this phase.' }
$restore = Invoke-ArchiveAws -Arguments @('backup', 'describe-restore-job', '--restore-job-id', $state.restore_job_id)
if ($Phase -eq 'RestoreStatus') { $restore | Select-Object RestoreJobId, Status, StatusMessage | ConvertTo-Json; exit 0 }
if ($restore.Status -ne 'COMPLETED') { throw "Restore must complete before verification; current state: $($restore.Status)" }

$restoredHead = Invoke-ArchiveAws -Arguments @('s3api', 'head-object', '--bucket', $restoreBucket, '--key', $objectKey)
if ($restoredHead.ContentLength -ne $state.original_size) { throw 'Restored byte count differs from original.' }
$bytesPath = Join-Path $stateRoot "artwork-restored-$AssetId.bin"
Invoke-ArchiveAws -Arguments @('s3api', 'get-object', '--bucket', $restoreBucket, '--key', $objectKey, '--version-id', $restoredHead.VersionId, $bytesPath) | Out-Null
$actual = (Get-FileHash -LiteralPath $bytesPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $state.expected_sha256) { throw 'Restored digest differs from the confirmed revision manifest.' }
$state.restored_version = $restoredHead.VersionId
$state.verified_sha256 = $actual
$state.verified_at = [DateTime]::UtcNow.ToString('o')
Save-DrillState $state
$state | ConvertTo-Json -Depth 10
