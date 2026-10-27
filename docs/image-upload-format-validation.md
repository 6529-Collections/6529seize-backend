# Image upload format validation

New drop and wave image multipart uploads always complete in the existing private
ingest bucket. The image worker checks the source bytes before writing the public
object. The filename and S3 `ContentType` are declarations, not evidence of format.

Supported JPEG, PNG, WebP and GIF containers must match their declared MIME type;
`image/jpg` is normalized to `image/jpeg`. HEIC/HEIF input is rejected with an
instruction to export the image as JPEG or PNG. Renaming a HEIC file is not
conversion. Still AVIF drop uploads retain their existing mandatory conversion to
WebP and their strict decode limits. HEIC is not an accepted upload format. PNG preview processing is shared with the on-demand resizer.

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

The API sets this metadata in `CreateMultipartUploadCommand`; clients receive
only signed `UploadPartCommand` URLs for the owned key/upload ID/part number.
Those URLs do not authorize creating or replacing an object or its metadata.
The ingest storage definition blocks public access and grants the existing
Lambda role access to the ingest prefixes. This remains a trusted AWS-credential
boundary: public-access blocking does not restrict a separately authorized IAM
principal. Before rollout, verify that no client principal has direct ingest
object-write/copy or multipart-initiation permissions. This PR does not audit or
change deployed IAM. See `src/dropMediaIngestStorage/serverless.yaml` and
`src/api-serverless/src/media/upload-media.service.ts` for the declared boundary.

Published objects carry `format-validated=true`. `privacy-sanitized=true` is set
only when bytes were actually sanitized. The format check is container/header
validation, not a claim that every pixel/frame of an unchanged original has been
decoded successfully. Full decoding still occurs when conversion or privacy
sanitization requires it. Unsupported signatures such as SVG are rejected before
handing their data to native format parsers.

The worker enforces the shared 256 MiB image byte ceiling before reading and
checks that received length matches S3's declared length. Read/write/network
failures, missing or inconsistent length and unmatched native failures remain
operational. Detected invalid/unsupported formats mark the upload failed once;
retrying a failed record does not publish it or repeat processing. Failed bytes
remain private under the existing ingest retention policy.
Known permanent input rejections use warning logs and the upload's error/status
fields; they do not emit an operational application-error alert. Unclassified,
transport and storage failures retain operational error reporting, including when
their processing retries are exhausted.

## Preview readiness and PNG limits

Image uploads become `ready` only after both standard `AUTOx450` and `AUTOx1080`
previews are generated, verified and stored alongside the original. A failed
preview or derivative write cannot report success; operational failures retry.
PNG previews use disposable Sharp processes with measured limits: 100 million
pixels for 8-bit and 64 million pixels for 16-bit, with a 100,000-pixel side limit.
Output fits within 4096 pixels per side, two million pixels and 10 MiB encoded.
Ordinary orientation, alpha, no-upscale and fit behavior is preserved; oversized
results are reduced to fit the bounded output. See
[PNG preview resource policy](png-preview-resource-policy.md).

All image sources are streamed to a task-owned directory. Non-PNG sanitization and AVIF conversion also use files instead of retaining full source/output buffers in Node; original re-encoding must fit its full-decode budget. Privacy-disabled originals
retain their exact bytes; privacy-enabled PNG stripping also runs in isolation.
A 30-second deadline and sampled combined-RSS guard protect each child; native
allocations are released on exit. This is not a hard allocation guarantee.
The sanitizer needs 1 GiB ephemeral storage to own source, transformed original
and previews until storage operations finish. Failed decoding stays private;
a partial storage failure may leave objects but never marks the upload ready.

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

Wave initiation accepts only PNG, JPEG and GIF MIME types; there is no supported
non-image wave upload path. Drop initiation validates filename extensions against
the declared MIME type before this service runs. The legacy-session guard is
defense in depth, not a retrospective audit of every historical public object.

## Service order and rollback

When rollout is authorized, deploy `mediaResizerLoop` before
`dropMediaSanitizer`. The existing API already routes images through private
ingest and exposes processing/ready/failed; this change needs no API deployment,
schema change or new queue. The sanitizer's byte ceiling and preview requirement
are authoritative. Existing frontend generic multipart transport limits do not
promise an image will pass server processing.

The sanitizer's reserved concurrency is unchanged. Both previews now contribute
to queue/publication latency. Observe SQS oldest-message age, backlog, errors,
throttles and DLQ messages during an authorized rollout. Retain a compatible
worker for queued uploads when rolling back; do not bypass preview readiness or
change the captured privacy policy. Already stored originals and derivatives
must be preserved.

## Help knowledge

Backend-owned guidance for `@help6529`: a failed HEIC upload requires exporting
real JPEG/PNG bytes, not changing the filename; newly uploaded images can remain
processing until format validation and both preview uploads finish; image files must be 256 MiB or smaller, and oversized PNGs need reduced dimensions; a rejected old upload session should
be restarted. The frontend-owned published Help Bot corpus has not been changed
in this backend-only PR and must incorporate this guidance in its next update.
