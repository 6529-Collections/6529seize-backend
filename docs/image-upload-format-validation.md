# Image upload format validation

New drop and wave image multipart uploads always complete in the existing private
ingest bucket. The image worker checks the source bytes before writing the public
object. The filename and S3 `ContentType` are declarations, not evidence of format.

Supported JPEG, PNG, WebP and GIF containers must match their declared MIME type;
`image/jpg` is normalized to `image/jpeg`. HEIC/HEIF input is rejected with an
instruction to export the image as JPEG or PNG. Renaming a HEIC file is not
conversion. Still AVIF drop uploads retain their existing mandatory conversion to
WebP and their strict decode limits. This PR does not add HEIC to accepted upload
formats or change the on-demand resizer.

## Privacy behavior

Format validation is independent of `DROP_MEDIA_SANITIZE_IMAGES`. The API captures
that flag in the private multipart object's `sanitize-image-metadata` metadata
when the upload starts. Parts cannot change it. The worker honors that captured
choice rather than consulting a potentially different worker environment:

- `false`: inspect the container format and publish exactly the original bytes,
  preserving JPEG metadata/orientation and GIF frames/timing.
- `true`: retain the existing orientation correction, re-encoding and metadata
  stripping.
- Missing policy: retain sanitization for older in-flight private uploads.
- AVIF: always convert to an oriented, metadata-free WebP as before.

Published objects carry `format-validated=true`. `privacy-sanitized=true` is set
only when bytes were actually sanitized. The format check is container/header
validation, not a claim that every pixel/frame of an unchanged original has been
decoded successfully. Full decoding still occurs when conversion or privacy
sanitization requires it. Unsupported signatures such as SVG are rejected before
handing their data to native format parsers.

The worker enforces the existing 500 MiB image byte ceiling before buffering and
checks that received length matches S3's declared length. Read/write/network
failures, missing or inconsistent length and unmatched native failures remain
operational. Detected invalid/unsupported formats mark the upload failed once;
retrying a failed record does not publish it or repeat processing. Failed bytes
remain private under the existing ingest retention policy.

## Client and compatibility contract

The existing multipart response, `media_upload_id`, processing/ready/failed states,
status endpoint and drop-update notifications are reused. Current drop creation
can attach processing media; current wave creation waits for ready via the same
status endpoint. No new API fields or frontend behavior are required.

Single-PUT image preparation is rejected for drops and waves regardless of the
privacy flag, directing callers to multipart upload. Old untracked public image
multipart sessions must restart, including every wave session and drop image
keys. They cannot request more signed parts or complete through the legacy public
path. Non-image drop uploads and distribution-photo endpoints retain their current
paths. A previously issued single-PUT URL cannot be revoked by this code and
remains valid until its existing one-hour expiry; this is not a retroactive repair
of public objects or a bucket-policy change.

## Service order and rollback

Deploy `dropMediaSanitizer` before `api` when rollout is authorized. The worker
must understand the captured privacy choice before the API routes ordinary images
through it. The existing ingest storage, database table and queue are reused; no
schema changes or resizer deployment are needed. API deployment already checks
the ingest bucket and queue. All images now incur queue/publication latency;
capacity and the existing worker concurrency need observation during rollout.

Rollback the API first to stop creating the new ingest policy. Drain or retain a
compatible worker for queued private uploads before rolling back the worker, so
uploads captured with privacy stripping disabled are not unexpectedly re-encoded.

## Help knowledge

Backend-owned guidance for `@help6529`: a failed HEIC upload requires exporting
real JPEG/PNG bytes, not changing the filename; newly uploaded images can remain
processing until format validation finishes; a rejected old upload session should
be restarted. The frontend-owned published Help Bot corpus has not been changed
in this backend-only PR and must incorporate this guidance in its next update.
