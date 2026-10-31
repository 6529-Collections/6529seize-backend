# Unencrypted DM deletion runbook (D146, 2026-12-01)

Owner decision 2026-10-31 (6529chain D146, P48 MG7 option (b)): members may
move their own unencrypted ("legacy") DM history into the new end-to-end
encrypted chat or export it. Then every server copy of unencrypted DM
content, backups included, is deleted on **2026-12-01**.

This runbook is a plan. Nothing in it runs on a schedule, and the deletion
steps run only after the owner confirms them on the day. Scope: waves with
`waves.is_direct_message` whose chat group has
`community_groups.is_direct_message` (today about 8,950 conversations).
Private non-DM waves are out of scope until the owner decides otherwise.

## 1. What is stored, and what happens to it

### Purged by `ops/scripts/legacy-dm-purge/cli.ts`

The full list is code, not prose:
`src/legacy-dm/legacy-dm-purge.inventory.ts`. Its test reads every entity
and fails when a table that references a drop or a wave is in neither the
purged nor the kept list.

| Data | Tables |
| --- | --- |
| Messages | `drops`, `drops_parts` (and its FULLTEXT index), `drops_metadatas` |
| Mentions and links | `drops_mentions`, `drop_mentioned_waves`, `drop_mentioned_groups`, `drops_referenced_nfts`, `drop_nft_links`, `drop_relations` |
| Media rows | `drop_medias`, `drop_media_uploads`, `drop_attachments`, `attachments` (only when no other drop links the attachment) |
| Reactions and personal state | `drop_reactions`, `drop_boosts`, `drop_bookmarks`, `drop_quickvote_skips`, `drop_curations` |
| Polls | `drop_polls`, `drop_poll_options`, `drop_poll_votes` |
| Signatures | `drop_author_signatures`, `device_signed_events` (bodies of signed DMs) |
| Notifications | `identity_notifications` by drop and by wave, with ids written to `push_notification_cancellations` so queued pushes are dropped |
| Feeds and follows | `activity_events`, `identity_subscriptions` (follows of a DM drop) |
| Moderation copies | `content_moderation_reports` (content snapshots), `content_moderation_pre_publication_checks`, `content_moderation_items` and `content_moderation_evaluations` (evidence, including rejected drafts matched by `scope.wave_id`), `content_moderation_audit_log`, `content_moderation_hidden_drops`, `content_moderation_drop_states` |
| Help bot | `help_bot_interactions` (questions asked in a DM) |

The description drop that every DM wave is created with stays, reset to its
fixed text (`gm! :gm1:`), so the wave shell stays valid.

### Kept (no message content)

The conversation shell and its metadata: `waves`, `waves_archive`,
`waves_metadatas`, the DM group in `community_groups`, `deleted_drops`
tombstones, counters (`wave_metrics`, `wave_dropper_metrics`), read
cursors (`wave_reader_metrics`), pins and notification preferences. Whether
this metadata also goes is an open owner question.

Reported, not deleted: an author's own deliberate import of their DM drop
into artwork documentation (`artwork_documentation_sources`). The plan
counts them (`documentationImports`).

### Media bytes

| Where | What | Action |
| --- | --- | --- |
| Public images bucket (behind `d3lqz0a4bldqgf.cloudfront.net`) | DM images and files at `drops/<uuid>/<file>`, resized variants beside them; older `waves/author_<id>/` keys | `media-execute` deletes every object version of each `drops/<uuid>/` directory, or the exact key and its variants, when no remaining row references it; then invalidate CloudFront |
| Drop media ingest bucket | Upload originals before sanitizing (`drop_media_uploads.ingest_key`) | Deleted with every version by `media-execute` |
| Attachments bucket | PDF/CSV originals (`attachments.original_key`) | Deleted with every version by `media-execute` |
| 6529's IPFS node | Attachments published with their CID | Unpin by hand from the CID list (§3.6); copies other nodes fetched cannot be recalled |

### Not in the database, and what we do

| Copy | Action |
| --- | --- |
| Aurora automated backups and point-in-time restore | Retention cut to 1 day after the purge (§4.2); the last copy ages out within 24 hours |
| Manual cluster snapshots, snapshot copies in other regions, snapshot exports to S3, AWS Backup recovery points, clones and restored clusters (for example `competition-retirement-*`) | Inventoried now (§4.1), no new ones until the purge, deleted after it (§4.3) |
| Aurora backtrack, binary logs | Checked and set to the minimum (§4.4) |
| `dbDumpsDaily` | Dumps only `transactions`, `delegations`, `consolidations` and the latest `nftdelegation_blocks` row; `db-dumps-daily-tables.test.ts` keeps DM tables out |
| Staging database and developer copies made by `scripts/sync-staging-db-local.sh` | Same purge on staging first (rehearsal); developers delete `.staging-db-dump/` and local MySQL copies and re-sync after it |
| CloudWatch and Sentry | Check whether any log group stored DM text (request bodies, Bedrock invocation logging) and its retention (§4.5) |
| Push previews already delivered through Google and Apple, emails, AI vendor copies under their retention, members' own exports and screenshots | Cannot be recalled. Users are told so |

## 2. Before the day

1. **Disclosure.** The legacy DM banner and the announcement go out first.
   Counsel reviews the wording (P48 MG7).
2. **No new copies.** From the announcement until the purge, take no manual
   snapshots, clones or exports of production that will outlive
   2026-12-01, and run the staging sync only if the local copy is deleted
   by then.
3. **Backup inventory** (§4.1), recorded privately by the operator.
4. **Staging rehearsal.** Set `LEGACY_DM_DELETION_CUTOFF` on the staging API
   to a past time (an ISO UTC value ending in `Z`) so writes close, then run
   §3 against staging: `plan`, `execute` with `LEGACY_DM_PURGE_WAVES` on two
   or three waves, check them, then all waves, then media. Restore the
   default afterwards.
5. **Production dry run** on the reader endpoint on 2026-11-30 (§3.2). Share
   the counts with the owner when asking for the go-ahead.

## 3. The purge (2026-12-01, after the owner confirms)

Writes close by themselves at 2026-12-01T00:00Z: the API refuses new DM
drops and new DMs with `403 LEGACY_DM_CLOSED`. The CLI also refuses to
delete before the cutoff.

### 3.1 Environment

Run from the repository root through the wrapper, from a machine with the
approved AWS credential chain and a private database connection. Keep
every output file owner-only and outside the checkout.

```bash
export LEGACY_DM_ENVIRONMENT=prod            # or staging
export LEGACY_DM_DB_HOST=... LEGACY_DM_DB_PORT=3306
export LEGACY_DM_DB_USER=... LEGACY_DM_DB_PASSWORD=...
export LEGACY_DM_DB_DATABASE=...
export LEGACY_DM_PUBLIC_BUCKET=...           # AWS_6529_IMAGES_BUCKET_NAME
export AWS_REGION=us-east-1                  # eu-west-1 for staging
RUN="bin/6529 exec ts-node -r tsconfig-paths/register ops/scripts/legacy-dm-purge/cli.ts"
```

### 3.2 Dry run (counts only)

```bash
$RUN plan ~/legacy-dm/prod-plan.json
```

Read-only transaction. Check: `blockers` all zero, `inconsistentWaves`
explained, `dmWaves` near 8,950. Rows in `(by wave)` overlap the
drop-based counts.

### 3.3 Delete rows

```bash
$RUN execute ~/legacy-dm/prod-media.jsonl \
  "prod:<database>:2026-12-01T00:00:00.000Z:execute"
```

One DM wave at a time, transactions of at most 100 drops
(`LEGACY_DM_PURGE_BATCH`, up to 500). Each batch appends the media it
unlinks to the manifest before deleting. Rerun the same command after any
interruption: it continues with what is left and repeats nothing. Watch the
writer's CPU and replica lag; pause between runs if needed.

### 3.4 Verify

`plan` again: `drops` 0 and every purged table 0. Then spot checks:

```sql
select count(*) from drops d join waves w on w.id = d.wave_id
 where w.is_direct_message = 1 and d.id <> w.description_drop_id;   -- 0
select count(*) from identity_notifications n
  join waves w on w.id = n.wave_id where w.is_direct_message = 1;    -- 0
```

### 3.5 Delete media

```bash
$RUN media-plan ~/legacy-dm/prod-media.jsonl ~/legacy-dm/prod-media-plan.json
$RUN media-execute ~/legacy-dm/prod-media.jsonl ~/legacy-dm/prod-media-done.json \
  "prod:<database>:2026-12-01T00:00:00.000Z:media-execute"
```

Before running, check whether the buckets are versioned or replicated:

```bash
aws s3api get-bucket-versioning --bucket "$LEGACY_DM_PUBLIC_BUCKET"
aws s3api get-bucket-replication --bucket "$LEGACY_DM_PUBLIC_BUCKET"
```

`media-execute` deletes every version and delete marker. If a replication
destination exists, run the same deletion there. Then invalidate the paths
in `cdnPaths` of the result file:

```bash
aws cloudfront create-invalidation --distribution-id ECGWRHUV1NM3I \
  --paths file://paths.json      # at most 3,000 paths per request
```

### 3.6 IPFS

For each CID in `ipfsCids`, on 6529's IPFS node: `ipfs pin rm <cid>`, then
`ipfs repo gc`. Also remove them from any pinning service 6529 pays for.

### 3.7 Search index and free pages

Deleted rows leave tokens in the InnoDB FULLTEXT auxiliary tables and bytes
in free pages until rebuilt. In a low-traffic window:

```sql
set global innodb_optimize_fulltext_only = on;
optimize table drops_parts;                 -- purges deleted FTS tokens
set global innodb_optimize_fulltext_only = off;
alter table drops_parts engine = InnoDB, algorithm = inplace, lock = none;
alter table drops engine = InnoDB, algorithm = inplace, lock = none;
```

On Aurora, set `innodb_optimize_fulltext_only` in the cluster parameter
group if the global variable is not writable. Repeat the rebuild for
`content_moderation_items`, `content_moderation_reports` and
`identity_notifications` if their size allows.

## 4. Backups

Record each value privately before changing it.

### 4.1 Inventory (now)

```bash
aws rds describe-db-clusters \
  --query 'DBClusters[].{id:DBClusterIdentifier,retention:BackupRetentionPeriod,backtrack:BacktrackWindow,clone:CloneGroupId}'
aws rds describe-db-cluster-snapshots --snapshot-type manual
aws rds describe-db-cluster-snapshots --snapshot-type shared
aws rds describe-db-cluster-automated-backups   # retained after a cluster was deleted
aws rds describe-export-tasks                   # snapshot exports to S3
aws backup list-protected-resources
aws backup list-backup-vaults
```

Run each in every region 6529 uses (`us-east-1`, `eu-west-1`) and for the
staging instance (`describe-db-instances`, `describe-db-snapshots`).

### 4.2 Automated backups (after §3.4 passes)

```bash
aws rds modify-db-cluster --db-cluster-identifier <prod cluster> \
  --backup-retention-period 1 --apply-immediately
```

Point-in-time restore to before the purge stays possible for up to 24
hours; after that no automated backup holds DM content. Restore the usual
retention on 2026-12-03. Do the same for staging.

### 4.3 Manual snapshots, copies, exports, clones

1. Take a fresh manual snapshot after the purge and check it restores.
2. Delete every manual snapshot, cross-region copy and AWS Backup recovery
   point taken before the purge (`delete-db-cluster-snapshot`,
   `delete-recovery-point`).
3. Delete snapshot exports in S3 and retained automated backups
   (`delete-db-cluster-automated-backup`).
4. Delete clones and restored clusters created before the purge, for
   example `competition-retirement-*-restore-*`.

### 4.4 Backtrack and binary logs

If `BacktrackWindow` is above 0, set it to 0 after the purge, then back.
If binary logging is on (`show variables like 'log_bin'`), check retention
with `call mysql.rds_show_configuration;` and let it lapse or set
`call mysql.rds_set_configuration('binlog retention hours', 1);`.

### 4.5 Logs and vendors

- `aws bedrock get-model-invocation-logging-configuration`: if it is on,
  delete the logged prompts from its S3 bucket or log group.
- Check API log groups for request bodies or drop text. If any hold DM
  text, the owner decides between deleting those streams and letting the
  retention lapse.

## 5. Sign-off

Record privately and summarize for the owner: the plan before and after,
the purge log, the media results, the IPFS unpin list, and the backup
changes with their times. The residual copies of §1 are stated in the
announcement.
