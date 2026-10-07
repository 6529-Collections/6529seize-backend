# Chat video previews

`dropVideoConversionInvokerLoop` creates one JPEG preview alongside each new
drop video's existing HLS and MP4 outputs. The frontend uses the preview as
the chat player poster, without loading or decoding the video before Play.
NFT and submission page playback policies are unchanged.

## Storage contract

For an original `drops/<author>/<name>.<extension>` in `S3_BUCKET`, the preview
is `renditions/drops/<author>/<name>/poster/<name>_poster.0000001.jpg` in the
same bucket and CloudFront distribution. The key uses MediaConvert's first
frame-capture number and the `_poster` name modifier. No API, database, or
upload response field is added.

The JPEG contains the first video frame at quality 80. Fit without upscaling
keeps its proportions within 640 by 640 pixels, including automatic input
rotation. A black first frame can still produce a black preview. Preview
availability is asynchronous; the frontend keeps Play available while a
preview is missing or processing, and retries only within a bounded period
while visible and active.

## Conversion and deployment

The worker reads `MC_DROPS_VIDEO_TEMPLATE_NAME`, preserves its codec, audio,
input selector, and group settings, replaces the existing HLS/MP4 destinations,
and appends a fully specified JPEG group. The existing regular video outputs
remain in the same job because MediaConvert requires them for frame capture.
The shared AWS template is not modified. An incompatible/missing template
fails before job submission and uses the existing Lambda retry/error path.

Deploy only `dropVideoConversionInvokerLoop`, including its template-scoped
`mediaconvert:GetJobTemplate` IAM policy, before the accompanying frontend.
The existing endpoint, execution role, template, bucket, and region environment
configuration remain required. No new environment variable, service, API
deployment, or database migration is needed. Rolling back the worker stops
preview generation for future uploads; already generated images remain usable.

Before release, submit an authorized test upload and verify the job completes,
the existing video outputs still play, and the documented JPEG key is served
by CloudFront. Include a portrait/rotated source. Mocked unit tests do not prove
the account's live template, IAM permissions, or MediaConvert service acceptance.

## Existing videos

Deploying this change does **not** enumerate or backfill existing uploads.
Their existing video renditions still play. A separate, explicitly authorized
backfill can replay selected original video keys through the updated worker;
this re-runs the whole conversion job, replaces the existing video renditions,
and incurs conversion cost. Do not replay rendition keys or copy/overwrite
originals merely to generate S3 events. Check for an existing preview first,
bound the selected originals, and retain submitted job IDs before any retry.
There is no automatic backfill or scheduled replay in this PR.

Reference: [AWS frame capture outputs](https://docs.aws.amazon.com/mediaconvert/latest/ug/file-group-with-frame-capture-output.html).
