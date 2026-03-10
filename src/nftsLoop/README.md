# nftsLoop

This loop keeps NFT rows current and drives S3 media processing.

## Entry points

- Lambda handler: `src/nftsLoop/index.ts`
- Core logic: `src/nftsLoop/nfts.ts`
- Audit precheck: `src/nftsLoop/s3-uploader-audit.ts`
- Outbox publisher: `src/nftsLoop/s3-uploader-outbox.publisher.ts`

## Modes

`nftsLoop` runs in three modes. The mode is passed in the Lambda event as `mode`.

### `discover` (on-chain)

1. Calls `tokenURI/uri` on-chain for next token ids per configured contract.
2. Fetches metadata for discovered NFTs.
3. Marks discovered rows as changed + mediaChanged.
4. Saves changed NFTs.
5. Builds S3 jobs only for newly discovered NFTs.
6. Saves S3 jobs into outbox rows in the same DB transaction.
7. Publishes pending outbox rows to SQS.

### `refresh` (on-chain)

1. Iterates existing NFTs from DB.
2. Calls `tokenURI/uri` on-chain.
3. Refetches metadata when URI changed or metadata missing.
4. Sets `mediaChanged=true` only when media fields were rehydrated.
5. Saves changed NFTs.
6. Builds S3 jobs only for NFTs with `mediaChanged=true`.
7. Saves jobs to outbox in the same DB transaction.
8. Publishes pending outbox rows to SQS.

### `audit` (DB + S3, no on-chain)

1. Loads current NFT rows from DB.
2. Builds possible S3 jobs per NFT.
3. Pre-checks S3 keys (existence + tx-id match).
4. Enqueues only missing/stale jobs directly to SQS.
5. Exits early (no discover/refresh path).

Notes:
- `audit` does not call on-chain `tokenURI/uri`.
- `audit` does not use outbox.
- Audit precheck concurrency is `S3_AUDIT_CHECK_CONCURRENCY` (default `25`, bounded `1..50`).

## S3 uploader pipeline

1. `nftsLoop` decides what jobs should exist.
2. Jobs go to SQS:
   - `discover/refresh`: via DB outbox + publisher
   - `audit`: directly after precheck
3. `s3Uploader` worker consumes one job.
4. Worker loads NFT by `(contract, tokenId)`.
5. Worker processes only requested variants.
6. Worker re-checks S3 and skips valid existing objects.

## Outbox (discover/refresh only)

Outbox prevents losing work when DB writes succeed but queue publish fails.

- Entity: `src/entities/IS3UploaderOutbox.ts`
- Table: `s3_uploader_outbox`
- Status flow: `pending -> published`
- Failed publish increments `attempts`, stores `last_error`, retried on next run.

## Scheduling

Current schedules in `src/nftsLoop/serverless.yaml`:

- `discover`: every 1 minute
- `refresh`: every 10 minutes
- `audit`: every 1 hour

## Logging

Log lines include mode in prefix, for example `[AUDIT]`.

In `audit` mode:
- One line per NFT: scanned/enqueued/no action jobs.
- One summary line per collection.
- One final overall summary line.

## Source note

This README summarizes `docs/s3-uploader-rework.txt` and current implementation in this folder.
