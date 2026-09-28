# GIF animation previews

Large GIFs can exceed the legacy resizer's 512 MiB decoded-work estimate even
when the uploaded file is small. Legacy requests retain their existing bounded
first-frame fallback. New drop and banner consumers use the `_gifv2` suffix on
an existing resize option, for example `AUTOx450_gifv2/image.gif`.

This document describes the branch implementation; deployment is not implied.

## Contract

The suffix remains part of the derivative S3 key. It is removed before checking
the configured size whitelist and locating the source. This gives existing
uploads fresh derivatives without modifying originals or deleting legacy
previews. The new contract verifies actual GIF content and publishes only the
animation, never a first-frame fallback. Non-GIF content is rejected.

For AUTO sizes, the worker computes the bounded output dimensions first and
uses one sequential native GIF decode/resize into a bounded RGBA strip. It does
not seek each source frame separately or resize every frame twice. Fixed crop
boxes retain the individually coalesced frame path and its repeated-scan guard.
The bounded strip is spooled to temporary disk and encoded as GIF with the
original frame delays and loop count. Inconsistent or invalid delay metadata is rejected
instead of inventing replacement timing. Output resolution may be lower than the
requested height to fit all frames; the post-crop aspect ratio is retained within pixel
rounding. Fixed boxes retain the requested cover/inside/outside semantics.

Limits (independent of compressed upload size):

- Existing 256 MiB streamed source-byte cap.
- At most 8,388,608 source pixels per frame and 120 frames.
- AUTO requests: at most 268,435,456 total source pixels through the sequential
  loader, in addition to the per-frame and frame-count limits.
- Fixed boxes: at most 2 billion estimated scanned pixels, charging every
  preceding frame for page-based GIF decoding.
- At most 8,388,608 total output pixels (32 MiB RGBA before encoding).
- At most a 20-second processing deadline and native Sharp timeouts, further
  bounded by Lambda time remaining after source spooling with two seconds
  reserved for upload/cleanup. Remaining Lambda time is checked again before
  uploading either an unchanged original or a re-encoded preview; insufficient
  time fails operationally without uploading. This reserve is not a guaranteed
  upload duration.
  Native operational errors remain failures; they do not publish a successful static derivative.

AUTO conversion uses only resize/color/alpha operations before materializing
the bounded output. Do not add operations that force a full-resolution
working copy (rotation, composition, or arbitrary extraction) to this path.
The libvips GIF loader advances through coalesced frames sequentially; native
encoder and working-copy allocations still require runtime verification. These are conservative resource controls, not a
measurement or guarantee of native peak memory. Source, raw strip and encoded
output are cleaned up together, including on conversion or upload failure.

For an AUTO dimension that needs no resize, an already-public original can be
copied byte-for-byte when it is at most 8 MiB and passes the existing complete
animation memory estimate and new frame limits. Fixed crop boxes still resize.
This avoids inflating optimized GIFs without changing dimensions.

## Rollout and recovery

1. Deploy only `mediaResizerLoop` for the backend change. Its catalog now sets
   2048 MiB of memory to provide CPU headroom; its deployment waits for both
   code and configuration updates and verifies this allocation. Other service
   deployments do not reconcile media-resizer configuration drift. The original source/output limits and
   20-second processing deadline remain unchanged. No API, database, queue,
   new service, environment variable, or size-whitelist update is needed.
2. Verify the large 30-frame regression GIF at 450px and the bounded 800px
   request on the actual Lambda runtime, including duration/memory headroom.
   Also verify the 117-frame submission GIF at 600px and the 1080px viewer path.
   Verify the already-fitting 32-frame banner is byte-identical to its original.
   Local native timing is not production Lambda timing.
3. Deploy the companion frontend to request the versioned GIF paths. Existing
   derivatives are replaced by new cache keys on demand; no bulk deletion or
   CloudFront invalidation is necessary for these consumers.

The new frontend falls back to legacy previews on errors and lets users load
an original GIF explicitly in the expanded viewer. Legacy fallbacks can be
static and must not be represented as guaranteed animated previews. Roll back
frontend URL selection first if necessary; backend legacy requests are unchanged.
No original files or legacy derivatives are mutated by this rollout.

The current service catalog has no staging target for this Lambda. Before enabling
frontend consumers, the deployment owner must verify the GIF cases on the actual
Lambda runtime; adding a separate staging target would be a separate change.

Upload filenames receive fresh UUIDs, so ordinary replacement uploads use new
source URLs. The new contract retains the legacy successful-derivative cache
policy (24 hours) and key relationship. Replacing an S3 source out of band under
the same key requires regenerating/removing its derivative and invalidating CDN
caches; `_gifv2` versions the processing contract, not source revisions.

The existing rejection marker deduplicates unsupported-codec *reports*, not
conversion attempts. GIF admission failures use the existing cacheable 422
response (five minutes); exhausted processing/Lambda deadlines and native
timeouts propagate as operational failures, without the input-rejection cache
policy. Clients advance through the fallback list once per mount, but
remounting or retrying can request the new path again. Resource budgets apply to
each attempt; runtime capacity/headroom verification remains required.

## Timeout regression verification

The original 30-frame, 16 MB GIF exhausted the shared 20-second decode/resize/
encode budget in production at 800px. The submission preview GIF contains 117
frames at 1920 x 1080 (88,856,878 bytes); per-frame seeking would scan over 14
billion pixels and was rejected before conversion. Sequential AUTO processing
removes this repeated work without dropping frames. The 117-frame preview is
bounded to 357 x 200 for a 600px request to retain all frames within the existing
output budget.

`scripts/benchmark-gif-preview.cjs` accepts a CommonJS preview bundle, a local
original GIF, and a requested height. It verifies frame count, delay, loop and
output-pixel bounds (or byte identity for a passthrough original), reports
duration/peak RSS, and cleans its own temporary
files. It never downloads media or calls production. Bundle with the matching
pinned Sharp dependencies and run in the Lambda Node 22 image pinned by
`media-compatibility.yml`. Keep inputs outside Git.

A constrained Linux x64 Lambda-image check at 1028 MiB / 0.58 CPU measured the
new 800px Louis XIV conversion at 9.2 seconds; the 117-frame submission took
18.4 seconds, leaving insufficient headroom. At 2048 MiB / 1.15 CPU, the
submission took 9.1 seconds with peak RSS approximately 295 MiB. These CPU
quotas approximate Lambda allocation; container results exclude S3 transfer,
cold starts and actual Lambda host variability. They do not replace actual
Lambda duration/memory and HTTP checks before rollout completion.

At the proposed allocation, the 30-frame GIF took 3.5 / 6.0 / 6.2 seconds for
450 / 800 / 1080 requests; the submission took 11.1 / 9.1 / 10.7 seconds for
450 / 600 / 1080 requests. All retained frame counts, delays and loop values.
The same constrained-runtime harness reproduced the deployed 800px encoder
failure (`timeout: 3% complete`) before the fix.
