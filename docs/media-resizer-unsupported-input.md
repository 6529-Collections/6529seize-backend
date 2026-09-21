# Unsupported image resizing

A HEIC payload can be stored under a WebP filename and MIME label. The deployed
Sharp/libheif build can read its metadata but reject compression during decoding.
The resizer recognizes only the exact native missing-compression-plugin error
(code 11.6003), and only when originating from metadata decoding or the Sharp
output stream. It returns HTTP 422 with `UNSUPPORTED_CODEC` and the existing
five-minute cache header. It does not convert that source or promise browser/CDN
negative caching. Other decoder failures and S3/source/upload failures retain
their existing behavior.

## Reporting

The first recognized rejection attempts to create an empty S3 object under
`_resize-rejections/v1/<sha256>`, using `If-None-Match: *`. The hash covers the
bucket, original key, source VersionId (or ETag), and failure category. It does
not include the requested thumbnail size. A successful claim emits one
`APPLICATION_ERROR`; an existing marker leaves a warning log and HTTP 422,
without throwing another Lambda failure. Concurrent conditional-write conflicts
are retried at most twice; only HTTP 412 means the marker already exists.
Missing revision metadata and marker storage failures emit a separate operational
error. Existing monitoring grouping/frequency is unchanged: first reports for
several assets may share one Discord group and its occurrence count.

Markers persist without an application TTL. A new source revision has a new
identity and can report again. Removing a marker permits another report; this
is an explicit recovery action, not part of ordinary requests. The marker holds
no image data, source path, or user content. The source fingerprint is logged for
investigation and is not included in the Discord envelope. Existing request logs
continue to identify the requested image.

This is a best-effort first report, not exactly-once alert delivery. An invocation
can terminate after claiming the marker but before its log is emitted, or logging
transport can fail; a timed-out conditional write can also have succeeded. Such
ambiguous writes report a marker failure where possible. No atomic transaction
exists between S3 and log delivery. The marker confirms a claim, not a Discord
receipt. Deleting markers or bucket lifecycle expiry can permit repeat reports.

## Validation and rollout

Regression coverage exercises the exact native error, controlled HTTP response,
concurrent claims, changed revisions, conditional conflicts, storage failures,
private diagnostic boundaries, and unchanged successful image processing. The
native error is injected into a real Sharp stream; no user-uploaded image is
committed as a fixture.

Deploy only `mediaResizerLoop`. It uses its existing S3 object-write permission;
the production execution role already has S3 access. No schema, API server,
monitoring runtime, or frontend deployment is required. Deployment should verify
the marker prefix is writable in the target bucket. This change does not repair
existing mislabeled assets or stop the frontend from requesting them. Supporting
HEIC conversion and ingestion-format validation are separate work.

Rollback by redeploying the preceding handler. Empty marker objects do not
interfere with the old resizer or its output keys.
