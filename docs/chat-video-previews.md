# Chat video previews

`dropVideoConversionInvokerLoop` creates up to two JPEG previews alongside each new
drop video's existing HLS and MP4 outputs. The frontend uses the preview as
the chat player poster, without loading or decoding the video before Play.
NFT and submission page playback policies are unchanged.

## Storage contract

For an original `drops/<author>/<name>.<extension>` in `S3_BUCKET`, the preview
is `renditions/drops/<author>/<name>/poster/<name>_poster.0000001.jpg` in the
same bucket and CloudFront distribution. MediaConvert captures the first frame
and a frame at one second with `MaxCaptures: 2` and a one-frame-per-second
interval. The frontend prefers sequence 1 and falls back to
`<name>_poster.0000000.jpg` for existing or sub-second videos. No API, database, or
upload response field is added.

The JPEGs use quality 80. The later frame avoids a black opening frame when
the video has visible content by one second. Fit without upscaling
keeps its proportions within 640 by 640 pixels, including automatic input
rotation. A video still black at one second can still have a black preview. Preview
availability is asynchronous; the frontend keeps Play available while a
preview is missing or processing. Missing previews get at most 20 checks,
backing off to one per minute while visible and active; legacy first-frame
previews get at most four additional checks for a later capture. A successful
later capture stops probing.

## Conversion and deployment

The worker reads `MC_DROPS_VIDEO_TEMPLATE_NAME`, preserves its codec, audio,
and group settings, preserves input-selector settings except for forcing
`VideoSelector.Rotate` to `AUTO`, replaces the existing HLS/MP4 destinations,
and appends a fully specified JPEG group. The existing regular video outputs
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

Deploy only `dropVideoConversionInvokerLoop`, including its template-scoped
`mediaconvert:GetJobTemplate` IAM policy, before the accompanying frontend.
The existing endpoint, execution role, template, bucket, and region environment
configuration remain required. No new environment variable, service, API
deployment, or database migration is needed. Rolling back the worker stops
preview generation for future uploads; already generated images remain usable.
The current service catalog permits this shared-media converter only in
`staging`; its existing bucket and account are shared configuration, not an
isolated staging media store. This PR does not change that topology. Check IAM
propagation and template lookup during release verification.

Before release, use separately authorized uploads to verify the live storage
contract with the accompanying frontend:

- For a clip longer than one second, confirm job completion, playable HLS/MP4
  renditions, CloudFront delivery of sequences 0 and 1, and preference for sequence
  1 in chat. Include a portrait/rotated source and check preview/playback geometry.
- For a sub-second clip, confirm job completion and playable video renditions.
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
