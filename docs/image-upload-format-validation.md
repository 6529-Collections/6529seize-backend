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

Format validation is independent of `DROP_MEDIA_SANITIZE_IMAGES`. The drop and
wave multipart start request carries an optional `purpose` (`chat`, the default,
or `decision_entry`), stored on the `drop_media_uploads` row; wave pictures are
always `chat`. The API captures `DROP_MEDIA_SANITIZE_IMAGES && purpose != decision_entry`
in the private multipart object's `sanitize-image-metadata` metadata when the
upload starts. Parts cannot change it. The worker honors that captured choice
rather than consulting a potentially different worker environment, and never
strips a `decision_entry` upload whatever the captured flag says:

- `decision_entry`, or `false`: inspect the container format and publish exactly
  the original bytes, preserving metadata, orientation and GIF frames/timing.
  The flag stays the production kill switch for chat stripping.
- `true`: strip identifying metadata losslessly (below), falling back to the
  existing orientation correction and re-encoding when the lossless result does
  not verify; the fallback is logged with its reason.
- Missing policy: retain sanitization for older in-flight private uploads.
- AVIF: always convert to an oriented, metadata-free WebP as before, including
  decision entries (the published format is WebP).

Lossless stripping (`src/media/metadata-strip/`) rewrites only the container and
copies image data verbatim. JPEG keeps JFIF (without its thumbnail), every
ICC_PROFILE chunk in order, the Adobe colour-transform marker, tables and scans;
EXIF becomes a 26-byte TIFF holding only Orientation (dropped when upright), and
XMP, IPTC/Photoshop, comments, other application segments, embedded thumbnails
and data after EOI are removed (HDR gain maps excepted, below). PNG keeps only rendering chunks (including iCCP,
sRGB, gAMA, cHRM, cICP and APNG chunks); text, time and private chunks are
removed and eXIf is reduced to Orientation. WebP drops EXIF/XMP/unknown chunks,
keeps ICCP and animation, and updates the VP8X flags and RIFF size. GIF drops
comments and application extensions other than looping (NETSCAPE2.0,
ANIMEXTS1.0) and the GIF ICC extension. The result must re-parse with the same
size, orientation and byte-identical render stream and none of the removed
blocks, and must decode with sharp to the same oriented size, frames, timing and
pixel hash as the input.

### Pixel check bounds

The pixel check (`decoded-pixel-digest.ts`) compares what sharp reports for
input and output (EXIF orientation as sharp applies it, stored size, frame
count and height, channels, sample depth, loop count and per-frame delays) and
then a SHA-256 of the decoded pixels of every frame (GIF and WebP load all
pages). It hashes the stored, unrotated pixels: equal orientation and equal
stored pixels mean equal oriented pixels, while auto-rotating would make
libvips copy the whole image into memory. Pixels are decoded with sequential
reads and hashed in bands of at most 64 MiB (whole frames, or row ranges of one
frame), contiguous so the hash equals that of the full raw image. Each band is
freed as soon as it is hashed, and libvips's operation cache is off so earlier
bands' decoders do not linger. Memory is therefore one band plus the
decoder's working set, whatever the image size. Each band restarts the decoder
from the top, so time grows with the number of bands, which the limits bound.

There is no decoded-size cap any more. Instead, an image is reported unverified
(and the sanitizer re-encodes it, or the backfill skips it) when it exceeds:

- the source limit: 256 MiB, the upload limit, by default
  (`LOSSLESS_STRIP_MAX_SOURCE_BYTES`); callers can pass their own;
- 268,435,456 decoded pixels (16,384 x 16,384) in all frames together, enforced
  by sharp's `limitInputPixels` before any pixel is decoded;
- 64 MP per frame for decoders that hold a whole frame (progressive or
  multi-scan JPEG, WebP, GIF), the AVIF and 16-bit PNG cap; single-scan
  baseline JPEG decodes row by row and is bound only by the pixel ceiling;
- for PNG, the upload pipeline's PNG limits (100 MP at 8 bits, 64 MP at 16
  bits, 100,000 pixels a side), read from IHDR before any native parser runs;
- 240 seconds for one verification (input, output and any gain maps).

These fit the 2 GiB, two-vCPU `dropMediaSanitizer` Lambda (900-second
timeout). Worst case: about 250 MiB for the runtime (180 MiB measured after
loading the bundle), up to 768 MiB of source and output buffers (256 MiB each,
plus one more output when a gain map fails to verify and is dropped), one
64 MiB band, and the decoder state. Row-by-row decoders (baseline JPEG,
non-interlaced PNG) use tens of MiB with two libvips threads; whole-frame
decoders at the 64 MP cap measured 370 MiB (progressive 4:4:4 JPEG) to about
400 MiB (WebP), and an interlaced 100 MP 8-bit PNG holds its 400 MB image. That
is about 1.6 GiB, leaving more than 20% headroom; ordinary uploads use far
less. The sanitizer frees the source and output buffers before it renders
previews, because the PNG preview worker shares a 1 GiB parent-plus-child RSS
limit with it. Measured with two libvips threads on a current Xeon, whole
verifications took 5-15 s for a 144 MP baseline JPEG (depending on content),
17 s for a 1,070-frame 268 MP GIF, 26 s for a 64 MP WebP, 38 s for a 64 MP
progressive 4:4:4 JPEG and 20 s for an 81 MP interlaced RGBA PNG; the 240 s
budget leaves room for slower Lambda CPUs. The check previously decoded each
image into one buffer, capped first at 128 MiB and then at 384 MiB of decoded
pixels, with a 30-second timeout that large images could exceed.

Before stripping, the sanitizer admits each non-PNG upload from its metadata
(`assertImageUploadFits`): the preview budget must hold it, and when it is to
be stripped but is beyond the source limit or these bounds
(`canVerifyDecodedPixels`), the re-encoding budget must hold it too. Otherwise
it fails at once with its dimensions and asks for a smaller image.

HDR gain maps in JPEG are kept, because they are not identifying. Ultra HDR
(Adobe/Google gain map v1 XMP, ISO 21496-1) and Apple HDR JPEGs are recognised
from the primary image's MPF index and/or Google container directory, and a
secondary image counts as a gain map only when its own metadata says so (`hdrgm`
gain map values, Apple's `urn:com:apple:photo:2020:aux:hdrgainmap` auxiliary
type, or ISO 21496-1 metadata). The primary image keeps a rebuilt minimal MPF
index (primary and gain maps only, no image UIDs), its ISO 21496-1 version block
and a new XMP packet holding only gain map values (`hdrgm:*`, a Primary/GainMap
container directory, Apple's `HDRGainMap:*` and `apdi:*` fields), each value
checked against a numeric, boolean, version or fixed-URN pattern. Each gain map
is stripped like the primary image and keeps its ISO 21496-1 metadata and gain
map XMP values. MPF offsets and container `Item:Length` values are rewritten for
the new layout. MPF thumbnails and previews, depth maps, portrait mattes, motion
photo video and other secondary images are dropped. The output must re-parse
with each gain map's render stream byte-identical, MPF offsets on each gain
map's SOI, and nothing outside the allowlist; in the sanitizer each gain map
must also decode with sharp to the same pixels. An unrecognised, inconsistent or
unverified gain map structure is dropped with a warning and the verified SDR
base image is published, as before; it never makes the upload fail or fall back
to re-encoding. PNG keeps the cICP, mDCv and cLLi HDR chunks. AVIF still
converts to WebP, which loses HDR.

Images already published before chat stripping are handled by a separate,
operator-run backfill that strips chat media in place with the same lossless
module and never touches decision entries; see
[chat media metadata backfill](chat-media-metadata-backfill.md).

Chat uploads and wave pictures are published as `<upload id>.<ext>` (lower-case
extension) in the upload's own folder, so the public URL never carries the
uploader's file name; decision entries keep a slug of the artist's file name.
New drop upload folders are the `drop_media_uploads` row id. Drop creation uses
that (or the request's `media_upload_id`) to reject, with a 400, media uploaded
as `decision_entry` on anything other than a participatory, non-reply drop, for
every media type.

Deploy `dbMigrationsLoop` (schema sync adds the nullable
`drop_media_uploads.purpose` column, which every new upload row writes) before
`api`. `dropMediaSanitizer` can deploy before or after `api`: an older worker
still honours the captured flag, which is already `false` for decision entries,
and a newer worker treats rows without a purpose as before. The frontend that
sends `purpose` deploys after `api`, because the previous API rejects the
unknown field.

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

Other formats are previewed in the sanitizer process after the same decoded-work
admission (512 MiB estimate, every GIF frame counted, first-frame fallback for
GIFs beyond it). Each of the two previews has a 120-second native timeout: both
together, the pixel check's 240-second budget and the S3 transfers stay well
inside the Lambda's 900-second timeout. GIF previews encode at libimagequant
effort 1, as `mediaResizerLoop` GIF previews do. Resizing a dithered animation
whose frames each carry their own palette, as video-to-GIF converters write
them, blends the dither into thousands of new colours per frame. With no shared
palette to reuse, the encoder builds a palette for every frame, and Sharp's
default effort 7 took about 70 seconds for one 450-pixel preview of a 128-frame
400 x 560 GIF. Under the previous 30-second timeout such uploads failed in
production with `timeout: 0% complete`; at effort 1 the same preview takes
9-12 seconds. Originals are never re-encoded for previews. A preview that still
times out stays an operational failure, so it is retried; once retries run out
the upload fails with "This image took too long to process. Reduce its
dimensions or animation frame count and upload again." Each preview logs its
format, dimensions, frame count and duration, never pixels.

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
