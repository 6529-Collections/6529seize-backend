# On-demand image resize failures

The resizer inspects source bytes, independently of the filename and S3 MIME
label. Detected HEIF/HEVC images use a pinned `libheif-js` WebAssembly decoder;
AVIF and other images retain their existing Sharp path. HEIC conversion produces
an explicit JPEG derivative with `image/jpeg` at the requested resized key. It
does not rename, replace or change the source object. This supports existing
mislabeled uploads; upload validation is separate work.

The HEVC decoder reads the primary image and applies its HEIF item transforms.
The derivative is a still SDR JPEG with metadata stripped, not an HDR/gain-map
preservation format. A source with a different suffix still receives JPEG bytes
and a matching JPEG content type. Existing resize fit and no-upscale rules apply.

## Decoder isolation and limits

The source is spooled into the invocation's temporary directory before metadata
inspection. A declared source length that differs from the received bytes remains
an operational failure, rather than being cached as a bad image.

Only detected HEVC starts the separate decoder process. HEIC input is limited to
32 MiB and 32 megapixels (32 × 1024² pixels), in addition to the existing decoded
work admission check. The child independently checks its decoded dimensions,
limits its JS heap to 256 MiB and each WASM memory to 512 MiB, and is killed after
at most 20 seconds. Lambda remaining time reduces that deadline, reserving two
seconds for upload. These are component budgets, not a hard total RSS guarantee
for Sharp's native allocations. Raw pixels remain in the child; only the JPEG
file is read by the parent. All temporary files are removed on success or failure.

A decoder-confirmed invalid container, unsupported input/feature, or pixel decode
failure returns `422 HEIC_DECODE_FAILED`. Those are explicit libheif error codes
2, 3, 4 and 7 from the dedicated HEVC-capable decoder. The generic native Sharp
`heif: ... (7.0)` message is **not** added to a broad suppression regex. Worker
startup, allocation failures, unexpected exceptions, timeouts, incomplete output,
S3 access, network and temporary-storage failures remain operational errors.

## Revision-aware rejection cache

Before HEVC pixel decoding, the resizer checks an empty rejection marker under
`_resize-rejections/v2/` in the source bucket. Its SHA-256 identity includes the
bucket, original key, source revision (VersionId, otherwise ETag), and decoder
policy `libheif-js-1.23.5-jpeg-v1`. The marker contains only the bounded
`HEIC_DECODE_FAILED` code in S3 metadata, with no source path or image data.

A decoder-confirmed permanent rejection conditionally creates the marker and
claims one operational report, across sizes and Lambda instances. Later requests
still fetch/spool the source and inspect metadata, but skip HEVC pixel decoding,
return a cacheable HTTP 422 (five minutes), and retain warning logs without
another application error or Lambda failure. They do not rewrite the marker.
Concurrent first requests can decode before the first marker is visible, but
only one conditional-write winner reports. HTTP 409 conditional conflicts have
bounded retries; only HTTP 412 means another invocation claimed the report.

A changed source revision or decoder policy permits a fresh attempt. Bump the
policy whenever decoder support or conversion behavior changes. Budget and
transient failures never create rejection markers. Lookup and write failures,
missing source identity, and invalid markers propagate as operational failures.
The execution role needs `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket` for
missing-marker HEAD responses to be distinguishable from access denial.

The preceding `_resize-rejections/v1/` behavior remains for Sharp's exact
`Support for this compression format has not been built in (11.6003)` error:
that marker deduplicates the report only, without a decode short-circuit. HEVC
images that reach metadata inspection now take the supported conversion path
before that native error can occur. Neither cache suppresses arbitrary HEIF
messages or infrastructure failures.

Reports are best effort, not exactly-once alert delivery. Termination after
claiming a marker but before logging can lose a first report. Logging transport
can also fail, and a timed-out write can have succeeded. Markers confirm a claim,
not delivery to a notification destination. Deleting markers or bucket lifecycle
expiry permits another report. Marker persistence has no application TTL.

## Service impact and recovery

Only `mediaResizerLoop` needs redeployment. Its ZIP includes the pinned decoder;
artifact verification decodes a synthetic HEVC fixture offline. No schema,
frontend, API server, or monitoring runtime changes are required. Tests cover
conversion, invalid pixel data, repeated and concurrent rejection, source/policy
changes, and operational failure boundaries. User media is never committed as a
fixture.

A valid HEIC can be processed without replacing the original. For a rejected
source, use a corrected source revision or a tested decoder/policy update to
permit another attempt. Removing its marker permits another attempt/report and
is an explicit recovery action. Rollback uses the preceding resizer handler;
empty rejection markers do not affect its source or derivative keys.
