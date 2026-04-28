# Attachments Upload Pipeline

Date: 2026-04-28

## Purpose

Attachments use a dedicated upload and processing pipeline for PDF and CSV
files. They do not use the normal `/drop-media` flow.

The pipeline stores the original upload privately, waits for malware scan
results, validates and processes the file asynchronously, and publishes the
processed artifact to IPFS only after it passes the processing checks.

## Supported Attachments

Attachment uploads currently accept:

- `application/pdf` with `.pdf`
- `text/csv` with `.csv`

Normal `/drop-media` uploads continue to handle image, video, audio, and GLB
media. PDF and CSV files are routed through `/attachments`.

## API Flow

Implemented attachment endpoints:

- `POST /attachments/multipart-upload`
- `POST /attachments/multipart-upload/part`
- `POST /attachments/multipart-upload/completion`
- `GET /attachments/{attachment_id}`

The upload sequence is:

1. The client calls `POST /attachments/multipart-upload` with `content_type` and
   `file_name`.
2. The API creates an `attachments` row with status `UPLOADING`.
3. The API starts a private S3 multipart upload and returns:
   - `attachment_id`
   - `upload_id`
   - `key`
   - `status`
4. The client calls `POST /attachments/multipart-upload/part` for each part and
   uploads directly to the returned signed S3 URLs.
5. The client calls `POST /attachments/multipart-upload/completion`.
6. The API completes the S3 multipart upload and moves the attachment to
   `VERIFYING`.
7. S3 emits an object-created event.
8. `attachmentsOrchestrator` waits for the GuardDuty object tag.
9. Clean objects are enqueued to `attachmentsProcessor`.
10. `attachmentsProcessor` validates/processes the file and publishes the final
    IPFS artifact.

Drop create/update payloads can reference attachments through
`parts[].attachments[]`:

```json
{
  "attachment_id": "..."
}
```

Drop responses hydrate each attachment reference into:

- `id`
- `file_name`
- `mime_type`
- `kind`
- `status`
- `url`
- `error_reason`

## Status Model

Internal statuses:

- `UPLOADING`
- `VERIFYING`
- `PROCESSING`
- `READY`
- `BLOCKED`
- `FAILED`

API statuses:

- `uploading`
- `verifying`
- `processing`
- `ready`
- `bad`

`BLOCKED` and `FAILED` are both exposed as `bad`.

## Storage Flow

Attachments upload to the private ingest bucket configured by:

- `ATTACHMENTS_INGEST_S3_BUCKET`

Object keys are scoped by runtime environment:

```text
<NODE_ENV>/attachments/incoming/author_<profileId>/<attachmentId>/original.<ext>
```

Examples of `<NODE_ENV>` are `local`, `development`, and `production`.

The S3 bucket is the source for GuardDuty scanning and processor downloads.
Processed output is not written back to public S3.

## Async Components

### `attachmentsOrchestrator`

The orchestrator is triggered by:

- S3 object-created events for the attachment ingest bucket/prefix
- Its retry SQS queue

It:

- finds the attachment row by original bucket/key
- waits while the attachment is still `UPLOADING`
- polls the `GuardDutyMalwareScanStatus` S3 object tag
- enqueues clean files for processing
- blocks files with `THREATS_FOUND` or `UNSUPPORTED`
- fails files when malware scan results time out or fail

### `attachmentsProcessor`

The processor is triggered by the attachment processing SQS queue.

It:

- claims `VERIFYING` attachments by moving them to `PROCESSING`
- downloads the private S3 object
- validates the file type and file content
- applies PDF or CSV processing rules
- uploads a directory bundle to IPFS
- marks the attachment `READY`, `BLOCKED`, or `FAILED`

## Final Artifact

The processor uploads to:

```text
${IPFS_API_ENDPOINT}/api/v0/add?pin=true&wrap-with-directory=true
```

The uploaded directory contains:

- the processed attachment file
- `metadata.json`

The database stores:

- `ipfs_cid`: the directory/root CID
- `ipfs_url`: the processed file URL inside that root CID

Public URL shape:

```text
ipfs://<rootCid>/<published-file-name>
```

Metadata URL shape:

```text
ipfs://<rootCid>/metadata.json
```

## Processor Limits

PDF limits:

- max file size: `25 MB`
- max pages: `100`

CSV limits:

- max file size: `10 MB`
- max rows: `100,000`
- max columns: `256`
- max cell length: `32 KB`
- max line length: `1 MB`

## Processor Checks

PDF checks:

- file signature must start with `%PDF-`
- file size must fit the PDF limit
- rough page count must fit the PDF limit
- encrypted PDFs are blocked by the `/Encrypt` marker
- risky PDF features are blocked by marker scan:
  - `/JS`
  - `/JavaScript`
  - `/OpenAction`
  - `/AA`
  - `/Launch`
  - `/SubmitForm`
  - `/EmbeddedFile`
  - `/RichMedia`
  - `/XFA`
  - `/Encrypt`

CSV checks and processing:

- binary-looking files are blocked
- NUL bytes are blocked
- UTF-8 decoding is required
- line, row, column, and cell limits are enforced
- CSV is parsed with a CSV parser
- formula-like cells are prefixed with a tab
- every output cell is quoted

## WebSocket Updates

Attachment status transitions are broadcast through the existing WebSocket
notifier as `ATTACHMENT_STATUS_UPDATE`.

The message payload uses the same `ApiAttachment` shape returned by REST
endpoints.

Updates are sent to:

- the attachment owner's active connections
- active connections subscribed to waves that reference the attachment through
  `drop_attachments.wave_id`

## Tables

Attachment data is stored in:

- `attachments`
- `drop_attachments`

Entity file:

- `src/entities/IAttachment.ts`

The `drop_attachments` table allows many attachments per drop part.

## Runtime Configuration

API:

- `ATTACHMENTS_INGEST_S3_BUCKET`

Orchestrator:

- `ATTACHMENTS_INGEST_S3_BUCKET` at deploy time for the EventBridge rule
- S3 EventBridge delivery enabled for the ingest bucket
- GuardDuty Malware Protection for S3 enabled for the ingest bucket/prefix

Processor:

- `IPFS_API_ENDPOINT`
- AWS access to read the ingest bucket
- AWS access to consume the processing SQS queue

## Deployable Services

The attachment pipeline adds:

- `attachmentsOrchestrator`
- `attachmentsProcessor`

They are listed in:

- `src/config/deploy-services.json`
- `.github/workflows/deploy.yml`
- `scripts/deploy-all-lambdas.sh`

## Redeploy Order

Use this order when deploying the attachment feature:

1. Schema sync path, normally `dbMigrationsLoop`
2. `attachmentsOrchestrator`
3. `attachmentsProcessor`
4. `api`

The tables must exist before the API and workers use them. The orchestrator and
processor should be available before the API starts accepting new attachment
uploads.
