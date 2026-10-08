# Chat video previews

During a drop-video upload the frontend attempts one frame from the local file
while its multipart data transfers. There is no extra upload step in the UI.
The API stores a validated device JPEG before completing the video object. The
converter creates JPEG previews only when that device image is unavailable;
HLS/MP4 conversion continues in either case. Chat uses the still image without
loading video before Play. NFT and submission page playback policies are unchanged.

## Upload and storage contract

The optional `video_poster_base64` multipart-completion field contains a JPEG,
without a data-URL prefix. The client seeks to one second, or halfway through a
sub-second clip, fits the frame within 640 by 640 pixels without upscaling, and
uses JPEG quality 75. Capture stops after eight seconds, cancellation, or app/tab
backgrounding; unsupported codecs and encoder failures omit the field. Parts
transfer concurrently with capture. Completion waits for the attempt to settle.

After checking upload ownership, the API checks canonical base64, a 128 KiB
compressed limit and 640 by 640 dimensions, then decodes and re-encodes the JPEG
at quality 80 to strip client metadata. It confirms the multipart upload still
exists before writing. Both S3 operations share a three-second deadline. Invalid
images, failed storage, and missing device images leave video completion usable;
the converter remains the fallback. Oversized request fields are rejected by the
request validator. Device posters are restricted to generated per-upload drop
video keys; wave media, distributions and attachments do not use this flow.

For `drops/<author>/<upload-uuid>/<name>.<extension>`, the API writes
`renditions/drops/<author>/<upload-uuid>/<name>/poster/<name>_device.jpg`
with `Content-Type: image/jpeg` and metadata `chat-video-poster: validated-v1`.
S3 publishes the video-created event only after this write attempt. The worker
checks this image's type, length and validation marker; a failed lookup generates
the backend preview instead. The two image paths are independent and cannot
overwrite each other. The uploaded original video is immediately playable;
HLS/MP4 renditions still arrive asynchronously.

The backend fallback captures the first frame and a frame at one second with
`MaxCaptures: 2` and a one-frame-per-second interval. Its keys are
`<name>_poster.0000000.jpg` and `<name>_poster.0000001.jpg` in the same poster
folder. JPEG quality 80 and automatic rotation retain proportions within 640 by
640. Short clips can have only the first capture. A clip still black at the
selected time can still have a black preview.

The frontend derives these URLs from the owned original upload URL; no poster
URL is added to the upload response or database. It prefers the device JPEG,
then the backend one-second image, then the legacy first image. A successful
device or later backend image stops probing. Missing images get at most 20
lookup cycles, backing off to one cycle per minute while visible and active;
each cycle checks at most three keys. Legacy first-frame images get at most
four additional cycles. Play remains available throughout. Device success
normally gives chat a poster as soon as the video is posted; CDN errors or
backend fallback can delay its appearance without requiring refresh within
the retry window.

## Conversion and deployment

The worker reads `MC_DROPS_VIDEO_TEMPLATE_NAME`, preserves its codec, audio,
and group settings, preserves input-selector settings except for forcing
`VideoSelector.Rotate` to `AUTO`, replaces the existing HLS/MP4 destinations,
and conditionally appends a fully specified JPEG group. The existing regular video outputs
remain in the same job because MediaConvert requires them for frame capture.
The shared AWS template is not modified. An incompatible/missing template
fails before job submission and uses the existing Lambda retry/error path.
The template must contain exactly one nonempty HLS group and one nonempty
FILE group for MP4 renditions. Additional or duplicate groups are rejected
before submission rather than sharing output destinations.

The deployed template, bucket, and bucket region are captured before shared
secret loading and retained for warm invocations.
`S3_BUCKET`, `BUCKET_REGION`, and `MC_DROPS_VIDEO_TEMPLATE_NAME` must be
provided by the function's Serverless environment configuration at cold start;
they must not be moved solely into the shared secret. `MC_ENDPOINT` and
`MC_ROLE_ARN` continue to come from the existing `prepEnvironment` secret-loading
path. The template-scoped policy intentionally attaches to the existing shared
`lambda-vpc-role`; other users of that role also gain read access to this one
template. The role ARN and policy role name identify the same configured account.

Each EventBridge event ID produces a stable 64-character job request token.
MediaConvert deduplicates repeat submissions within its one-minute idempotency
window. Later redelivery can still submit another job; durable deduplication is
not introduced here. Keys come from the upload service's generated author/upload
UUID path and sanitized filename, and are passed as opaque S3 keys.

Before enabling this frontend, deploy the converter and its policy, then the
API completion handler. The converter's existing shared `lambda-vpc-role`
policy gains `s3:GetObject` and `s3:PutObject` for device-poster keys and
`s3:ListMultipartUploadParts` for drop originals, alongside template-read access.
**Verify the existing API function's actual execution role has the same narrow
poster-write and pending-upload-read permissions before API rollout.** The
API deployment reuses an existing function/role; this repository's shared-role
policy does not prove that role is attached to the API. Live AWS credentials
were unavailable during implementation, so that association is unverified.

Existing endpoint, execution role, template, bucket, and region configuration
remain required. There are no new environment variables, services, queues or
migrations. The converter remains a shared-media, staging-only service under
the current catalog; API deployment follows the ordinary environment catalog.
Keep the converter deployed before API/FE so clients without a usable device
poster still get fallback capture. Old clients omit the optional field. An
older API may reject it, so deploying frontend first is unsupported. Rolling
back capture does not remove already-stored images. Check IAM propagation,
template lookup and public JPEG delivery during rollout.

Before release, use separately authorized uploads to verify the live storage
contract with the accompanying frontend:

- With supported desktop/mobile uploads, confirm the completion request includes
  a bounded JPEG, the validated device object exists before completion returns,
  chat shows it without refresh, and the conversion job retains HLS/MP4 while
  omitting the capture group. Include portrait/rotated preview/playback geometry.
- With device capture omitted or deliberately unavailable, confirm backend job
  completion, playable HLS/MP4 and both long-clip JPEGs. Verify sequence 1 is
  preferred and missing posters do not start downloading video.
- With device capture omitted for a sub-second clip, confirm job completion and playable video renditions.
  Verify the emitted sequence-0 JPEG is displayed without refresh when sequence 1
  is absent, and that video is not fetched before Play. Observe that preferred-key
  retries stop within the configured four additional checks after fallback loads.

Unit tests guard submitted capture settings; they do not prove frame numbering,
timestamps, the account's live template, IAM permissions, or service acceptance.
Live verification of the long and sub-second cases remains required during rollout.

## Existing videos

Deploying this change does **not** enumerate or backfill existing uploads.
Their existing video renditions still play. A separate, explicitly authorized
backfill can replay selected original video keys through the updated worker;
this re-runs the whole conversion job, replaces the existing video renditions,
and incurs conversion cost. An authorized backfill needs its own plan for
protecting existing renditions; replacement is not atomic across the HLS/MP4
output objects. Do not replay rendition keys or copy/overwrite originals merely
to generate S3 events. Check for an existing preferred preview first,
bound the selected originals, and retain submitted job IDs before any retry.
There is no automatic backfill or scheduled replay in this PR.

Reference: [AWS frame capture outputs](https://docs.aws.amazon.com/mediaconvert/latest/ug/file-group-with-frame-capture-output.html).
See also [MediaConvert idempotency](https://docs.aws.amazon.com/mediaconvert/latest/apireference/idempotency.html).
