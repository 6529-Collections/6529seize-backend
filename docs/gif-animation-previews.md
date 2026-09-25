# GIF animation previews

Large GIFs can exceed the legacy resizer's 512 MiB decoded-work estimate even
when the uploaded file is small. Legacy requests retain their existing bounded
first-frame fallback. New drop and banner consumers use the `_gifv2` suffix on
an existing resize option, for example `AUTOx450_gifv2/image.gif`.

## Contract

The suffix remains part of the derivative S3 key. It is removed before checking
the configured size whitelist and locating the source. This gives existing
uploads fresh derivatives without modifying originals or deleting legacy
previews. The new contract verifies actual GIF content and publishes only the
animation, never a first-frame fallback. Non-GIF content is rejected.

The worker reads one coalesced GIF frame at a time, resizes it, and spools RGBA
pixels to temporary disk. It encodes the bounded strip as GIF with the original
frame delays and loop count. Output resolution may be lower than the requested
height to fit all frames; aspect ratio is retained within pixel rounding.

Limits (independent of compressed upload size):

- Existing 256 MiB streamed source-byte cap.
- At most 8,388,608 source pixels per frame and 120 frames.
- At most 2 billion estimated scanned pixels, charging every preceding frame
  for page-based GIF decoding.
- At most 8,388,608 total output pixels (32 MiB RGBA before encoding).
- 20-second processing deadline and native Sharp timeouts. Native operational
  errors remain failures; they do not publish a successful static derivative.

Frame, encoder, and working-copy allocations remain bounded independently of
the full source animation. These are conservative resource controls, not a
measurement or guarantee of native peak memory. Source, raw strip and encoded
output are cleaned up together, including on conversion or upload failure.

For an AUTO dimension that needs no resize, an already-public original can be
copied byte-for-byte when it is at most 8 MiB and passes the existing complete
animation memory estimate and new frame limits. Fixed crop boxes still resize.
This avoids inflating optimized GIFs without changing dimensions.

## Rollout and recovery

1. Deploy only `mediaResizerLoop` for the backend change. No API, database,
   queue, new service, environment variable, or size-whitelist update is needed.
2. Deploy the companion frontend to request the versioned GIF paths. Existing
   derivatives are replaced by new cache keys on demand; no bulk deletion or
   CloudFront invalidation is necessary for these consumers.
3. Verify the large 30-frame regression GIF at 450px and the bounded 800px
   request on the actual Lambda runtime, including duration/memory headroom.
   Verify the already-fitting 32-frame banner is byte-identical to its original.
   Local native timing is not production Lambda timing.

The new frontend falls back to legacy previews on errors and lets users load
an original GIF explicitly in the expanded viewer. Legacy fallbacks can be
static and must not be represented as guaranteed animated previews. Roll back
frontend URL selection first if necessary; backend legacy requests are unchanged.
No original files or legacy derivatives are mutated by this rollout.
