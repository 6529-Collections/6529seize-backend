# Attachments Upload Pipeline

Date: 2026-04-27

## Purpose

This documents the new PDF/CSV attachment flow that is separate from normal
`/drop-media` uploads.

Normal media uploads remain for image/video/audio/GLB-style drop media.
Riskier document attachments now use a dedicated multipart upload flow, a DB
backed status model, and an async processor before they become public IPFS
artifacts.

This work is intended for attachments on drops/chats/waves/DM-like surfaces
where one drop part can contain many attachments.

## Scope of the current implementation

Implemented now:

- New `attachments` table/entity
- New `drop_attachments` join table/entity
- New API endpoints under `/attachments`
- Private ingest S3 multipart upload path for attachments
- GuardDuty-aware orchestration layer between ingest and processing
- Async SQS-backed processing worker
- Attachment status model visible to clients
- PDF verification path
- CSV verification + spreadsheet-safe output path
- Final processed artifact uploaded to IPFS as a directory CID containing:
  - the processed file
  - `metadata.json`

Not implemented yet:

- True PDF CDR / sanitization / flattening
- Separate attachment delivery domain for non-IPFS/private serving

So the current system is materially stricter than direct public upload, but it
is still not the full end-state your manager described because true PDF CDR and
some serving/policy refinements are still pending.

## Product/API shape

### Normal media vs attachments

- `/drop-media` is for ordinary drop media only
  - images
  - video
  - audio
  - GLB
- `/drop-media` no longer accepts:
  - `application/pdf`
  - `text/csv`
- PDF and CSV now go through `/attachments`

### One drop part can contain many attachments

Drop create/update payloads now support:

- `parts[].attachments[]`

Each attachment reference is:

- `attachment_id`

Drop fetch responses now hydrate each attachment into:

- `id`
- `file_name`
- `mime_type`
- `kind`
- `status`
- `url`
- `error_reason`

## Status model

Internal statuses:

- `UPLOADING`
- `VERIFYING`
- `PROCESSING`
- `READY`
- `BLOCKED`
- `FAILED`

API/public statuses:

- `uploading`
- `verifying`
- `processing`
- `ready`
- `bad`

The public `bad` status represents both internal `BLOCKED` and `FAILED`
outcomes, so clients can handle rejected and failed attachments uniformly.

Expected flow:

1. FE calls attachment multipart init
2. Backend creates attachment row with `UPLOADING`
3. FE uploads parts directly to private S3 using signed URLs
4. FE calls multipart completion
5. Backend marks attachment `VERIFYING`
6. S3 object-created event reaches the attachments orchestrator
7. Orchestrator waits for GuardDuty malware scan verdict
8. If GuardDuty is clean, orchestrator enqueues processing
9. Worker marks attachment `PROCESSING`
10. Worker either:
   - marks `READY` and stores IPFS CID/URL
   - marks `BLOCKED`
   - or marks `FAILED` if orchestration/scan state times out or fails

## API endpoints

Implemented in `src/api-serverless/src/attachments/attachments.routes.ts`.

- `POST /attachments/multipart-upload`
- `POST /attachments/multipart-upload/part`
- `POST /attachments/multipart-upload/completion`
- `GET /attachments/{attachment_id}`

These follow the same multipart pattern the frontend already uses, but do not
return a final public media URL at upload completion time. The final public URL
only exists after async processing succeeds.

## Storage flow

### Ingest

Attachments upload to a single private S3 bucket configured by:

- `ATTACHMENTS_INGEST_S3_BUCKET` (e.g. `6529-attachments-ingest`)

The bucket is partitioned by `NODE_ENV` (`local` | `development` | `production`)
to keep stages separated.

Current key pattern:

- `<NODE_ENV>/attachments/incoming/author_<profileId>/<attachmentId>/original.<ext>`

### Processing

There are now two async stages after upload completion:

1. `attachmentsOrchestrator`
   - triggered by S3 object-created events
   - retries while waiting for GuardDuty tag results
   - blocks or fails attachments based on GuardDuty verdict
   - only enqueues processing once the object is clean
2. `attachmentsProcessor`
   - downloads the private object
   - validates/processes it
   - uploads the processed artifact bundle to IPFS

### Final public artifact

Current IPFS upload behavior:

- `POST ${IPFS_API_ENDPOINT}/api/v0/add?pin=true&wrap-with-directory=true`

Current output is a directory CID containing:

- `/<rootCid>/<published-file-name>`
- `/<rootCid>/metadata.json`

Current DB storage behavior:

- `ipfs_cid` stores the directory/root CID
- `ipfs_url` stores the file URL inside that root CID

Current public file URL shape:

- `ipfs://<rootCid>/<published-file-name>`

Current public metadata URL shape:

- `ipfs://<rootCid>/metadata.json`

## MIME types

Current attachment MIME allowlist:

- `application/pdf`
- `text/csv`

Current normal `/drop-media` allowlist still includes:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/gif`
- `image/webp`
- `video/mp4`
- `video/x-msvideo`
- `video/quicktime`
- `audio/mpeg`
- `audio/mpeg3`
- `audio/ogg`
- `audio/mp3`
- `audio/wav`
- `audio/aac`
- `audio/x-aac`
- `model/gltf-binary`

## File name handling

Attachment upload validation currently requires:

- extension consistent with declared MIME
- no path separators
- no NUL bytes
- no leading/trailing whitespace
- no dangerous executable-style extensions

Current attachment extensions:

- PDF: `.pdf`
- CSV: `.csv`

For IPFS publication:

- the processed file name is slugified/sanitized
- `metadata.json` preserves original file name and other public-safe metadata

Current bundle metadata includes:

- `attachment_id`
- `owner_profile_id`
- `created_at`
- `kind`
- `original_file_name`
- `published_file_name`
- `declared_mime`
- `detected_mime`
- `published_mime`
- `sha256`
- `size_bytes`
- `verdict`

## Current processor checks

Implemented in `src/attachments/attachments-processing.service.ts`.

### PDF checks

- file signature must begin with `%PDF-`
- max size cap
- rough max page count
- encrypted PDFs are blocked via `/Encrypt` marker detection
- blocklist scan for obvious risky markers:
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

Important: this is validation/blocking, not full sanitization.

### CSV checks

- reject binary-looking files
- reject NUL bytes
- UTF-8 decode required
- max line length
- parse with real CSV parser
- row/column/cell limits
- spreadsheet-safe output by prefixing dangerous formula-like cells with tab
- quote every output cell

## Hard caps introduced

Current constants in `src/attachments/attachments-processing.service.ts`:

### PDF

- max file size: `25 MB`
- max pages: `100`

### CSV

- max file size: `10 MB`
- max rows: `100,000`
- max columns: `256`
- max cell length: `32 KB`
- max line length: `1 MB`

## New entities / tables

Added:

- `attachments`
- `drop_attachments`

Entity files:

- `src/entities/IAttachment.ts`

The join table allows many attachments per drop part.

## New services/components

### API

- `src/api-serverless/src/attachments/attachments.routes.ts`
- `src/api-serverless/src/attachments/attachments.mappers.ts`
- `src/api-serverless/src/attachments/upload-attachments.service.ts`

### Backend/shared

- `src/attachments/attachments.db.ts`
- `src/attachments/attachments-orchestrator.service.ts`
- `src/attachments/attachments-orchestration-publisher.ts`
- `src/attachments/attachments-queues.ts`
- `src/attachments/attachments-processing.service.ts`
- `src/attachments/attachments-processing-publisher.ts`
- `src/attachments/ipfs-file-uploader.ts`

### Worker Lambdas

- `src/attachmentsOrchestrator/index.ts`
- `src/attachmentsOrchestrator/serverless.yaml`
- `src/attachmentsOrchestrator/package.json`
- `src/attachmentsProcessor/index.ts`
- `src/attachmentsProcessor/serverless.yaml`
- `src/attachmentsProcessor/package.json`

## Triggering model

Current trigger path is:

1. FE calls `POST /attachments/multipart-upload/completion`
2. API completes multipart upload in S3
3. API sets attachment to `VERIFYING`
4. S3 emits `Object Created`
5. `attachmentsOrchestrator` Lambda receives the event
6. Orchestrator polls for the GuardDuty scan tag
7. If clean, orchestrator enqueues `attachmentsProcessor`
8. Worker processes attachment and moves it to `READY` or `BLOCKED`

The orchestrator also has its own retry SQS queue so GuardDuty polling does not
have to be handled in one long-lived Lambda invocation.

## Environment variables

### API

Required for the new attachment flow:

- `ATTACHMENTS_INGEST_S3_BUCKET`

The runtime stage subfolder is derived from `NODE_ENV`, which is already set
per environment.

### Orchestrator deploy/runtime

Required/assumed:

- `ATTACHMENTS_INGEST_S3_BUCKET`

This is used in the orchestrator serverless event pattern so the deployed rule
only listens for object-created events from the attachment ingest bucket.

Also required outside the codebase:

- S3 bucket event delivery to EventBridge enabled for the ingest bucket
- GuardDuty Malware Protection for S3 enabled for the ingest bucket/prefix

### Processor runtime

Currently used by `attachmentsProcessor`:

- `IPFS_API_ENDPOINT`

This is injected from deploy-time environment/secrets by `serverless.yaml`.

The worker also needs AWS access to:

- read from `ATTACHMENTS_INGEST_S3_BUCKET`
- consume the SQS queue

If the ingest bucket name should be environment-specific, that variable still
needs to be present at deploy time for the orchestrator service.

## Deployment

### New deployable service

Yes, this now introduces two attachment services in the deploy workflow:

- `attachmentsOrchestrator`
- `attachmentsProcessor`

It has been added to:

- `src/config/deploy-services.json`
- `.github/workflows/deploy.yml`
- `scripts/deploy-all-lambdas.sh`

### Redeploy order

Safest order:

1. schema sync path
   - whichever deployment path runs TypeORM sync / entity creation
   - typically `dbMigrationsLoop` or your normal schema-sync deployment step
2. `attachmentsOrchestrator`
3. `attachmentsProcessor`
4. `api`

### Why this order

- The new tables must exist before API/worker start using them.
- The orchestrator should exist before attachment completion begins relying on
  S3 events + GuardDuty gating.
- The processor should exist before the orchestrator starts handing off clean
  attachments.
- The API goes last so the new attachment completion semantics match the
  deployed async infrastructure.

## Security posture today

Today’s security level:

- attachment MIME allowlist
- filename/extension restrictions
- private ingest storage
- GuardDuty-gated orchestration before processing
- async processing gate before public IPFS
- basic PDF risky-feature blocking
- CSV spreadsheet-safety output transformation

Still missing for the full target architecture:

- quarantine release based on malware verdict
- true PDF sanitization/CDR
- richer audit/moderation metadata on public artifact packaging
- optional private/non-IPFS serving mode for contexts that should not be public

## Real-time status updates

The processor and orchestrator now push attachment status transitions over the
existing WebSocket infrastructure. Clients receive an `ATTACHMENT_STATUS_UPDATE`
message whose `data` payload is the same `ApiAttachment` shape returned by the
REST endpoints. Updates are pushed to:

- the owner's currently online connections
- every connection currently subscribed to a wave the attachment is referenced
  in (via `drop_attachments.wave_id`)

Transitions that broadcast a WS event:

- `UPLOADING -> VERIFYING` (from `POST /attachments/multipart-upload/completion`)
- `VERIFYING -> PROCESSING` (from `attachmentsProcessor`)
- `PROCESSING -> READY` (from `attachmentsProcessor`)
- `PROCESSING -> BLOCKED` (from `attachmentsProcessor`)
- `VERIFYING -> BLOCKED` (from `attachmentsOrchestrator` on
  `THREATS_FOUND`/`UNSUPPORTED`)
- `VERIFYING -> FAILED` (from `attachmentsOrchestrator` on scan timeout/failure)
- `UPLOADING -> FAILED` (from `attachmentsOrchestrator` on upload completion
  timeout)

## Recommended next steps

1. Add stronger PDF sanitization / flattening if PDFs will be broadly used
2. Document client-side reconnect/replay semantics for missed
   `ATTACHMENT_STATUS_UPDATE` messages
3. Decide whether to expose metadata URL through API models directly
4. Add richer public metadata only if the product actually needs it
