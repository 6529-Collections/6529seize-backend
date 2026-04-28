# Drop Attachments Process

Date: 2026-04-28

## What Attachments Do

Attachments let authenticated profile owners attach PDF and CSV documents to
drop parts. Each drop part can reference multiple attachments.

Attachments are uploaded through a dedicated attachment flow, stored privately
while they are being verified, processed asynchronously, and exposed only after
their status has been recorded.

Ready attachments are published as IPFS directory bundles. The API returns the
processed file URL when processing succeeds.

## Accepted Files

Accepted MIME types and extensions:

- PDF files
- CSV files

Upload file names must:

- use the extension allowed for the declared MIME type
- avoid path separators
- avoid NUL bytes
- avoid leading or trailing whitespace
- avoid dangerous executable-style extensions

Published IPFS file names are sanitized from the original file name.
Published file extensions are forced from the attachment type, so PDF
attachments publish as `.pdf` and CSV attachments publish as `.csv`.

## Size And Shape Limits

PDF:

- max file size: 25 MB
- max pages: 100

CSV:

- max file size: 50 MB
- max rows: 100,000
- max columns: 256
- max cell length: 32 KB
- max line length: 1 MB

## Upload Lifecycle

1. The client starts an attachment upload.
2. The backend records the attachment as uploading.
3. The client uploads file parts directly to private storage using signed URLs.
4. The client completes the upload.
5. The backend marks the attachment as verifying.
6. The backend waits for the malware scan result.
7. Clean files are sent to the processor.
8. The processor validates and processes the file.
9. The processor publishes an IPFS directory bundle and marks the attachment as
   ready.

If scanning or processing blocks or fails a file, the API exposes the attachment
as bad.

## Statuses

- uploading: upload has started.
- verifying: upload is complete and waiting for scan or processing.
- processing: the backend is validating and preparing the final artifact.
- ready: the processed artifact is available.
- bad: the attachment was blocked or failed.

Drops reference attachments by attachment id. Drop responses include each
attachment's id, file name, MIME type, kind, status, final URL when ready, and
error reason when the attachment is bad.

## Security Measures

Authentication and ownership:

- all attachment endpoints require an authenticated user
- upload initialization requires an existing profile
- attachment lookups only return attachments owned by the authenticated profile
- signed upload part URLs are issued only after the backend verifies the
  requested storage key belongs to an attachment owned by the authenticated
  profile
- upload completion verifies both attachment ownership and that the submitted
  storage key matches the key recorded for that attachment
- drop create/update validates that referenced attachments belong to the drop
  author
- drop create/update rejects duplicate attachment references in a drop part
- blocked or failed attachments cannot be used in drops

Private ingest:

- original uploads go to private storage
- keys are scoped under the runtime environment, profile id, and attachment id
- original private files are not returned as public URLs
- clients upload directly to private storage using short-lived signed upload
  URLs

Malware scanning:

- new private uploads trigger malware scan orchestration
- the backend waits for the GuardDuty malware scan result
- files with no threats found continue to processing
- files with threats found, or files GuardDuty cannot support, are blocked
- scan timeout, access denied, or failed scan states fail the attachment
- status transitions use conditional updates so stale retry messages do not
  overwrite newer attachment states

PDF validation:

- PDF signature must be valid
- encrypted PDFs are blocked
- JavaScript, auto-open actions, launch actions, embedded files, rich media,
  XFA, submit forms, and similar risky markers are blocked
- file size and page limits are enforced
- PDF files are validated and then published as the original PDF bytes when
  they pass validation

CSV validation and rewriting:

- binary-looking files are blocked
- NUL bytes are blocked
- UTF-8 decoding is required
- file size is enforced before and during download from private storage
- row, column, cell, and line limits are enforced
- spreadsheet formula injection is mitigated by prefixing formula-like cells
  with a tab
- output CSV cells are quoted
- the published CSV is rebuilt from parsed rows instead of publishing the
  original uploaded CSV bytes

Public artifact packaging:

- final artifacts are uploaded to IPFS with directory wrapping
- public-safe metadata is included with the artifact
- metadata includes declared MIME, detected MIME, SHA-256, size, owner profile
  id, original file name, published file name, and verdict
- SHA-256 and size are calculated from the final published payload

## Real-Time Updates

Attachment status transitions are sent over WebSocket as
attachment status updates.

Updates go to:

- the attachment owner
- online listeners subscribed to waves where the attachment is referenced

The WebSocket payload uses the same attachment shape as the REST API.
