# PNG preview resource policy

Large PNGs use the same isolated renderer in on-demand resizing and drop/wave
upload finalization. Increasing the old decoded-work constant would also widen
unrelated codecs and would not bound output size, lifetime or retained native
allocations. The PNG path instead combines measured admission, bounded output,
file-based I/O and a disposable child process.

## Native measurements

On 26 October 2026, a temporary AWS Lambda ran x86_64, 2048 MiB and Node
22.23.2, pinned to the production resizer's exact managed runtime version.
Its Sharp 0.35.4/libvips 8.18.6 dependencies came from the deployed artifact.
The original production PNG was 52,941,992 bytes, 8000 by 8000, RGBA, 8-bit,
non-interlaced. User media was not committed as a fixture. S3 reads/writes in
the benchmark handler were replaced with local streams/files; its real SDK
multipart buffering and resize operations were retained.

| Input                        | Resize-process high-water RSS |
| ---------------------------- | ----------------------------: |
| Original, fresh process      |                       200 MiB |
| Original, 20 sequential jobs |                       234 MiB |
| 64 MP, 8-bit interlaced      |                       468 MiB |
| 64 MP, 16-bit interlaced     |                       718 MiB |
| 100 MP, 8-bit interlaced     |                       588 MiB |
| 100 MP, 16-bit interlaced    |                       998 MiB |
| 144 MP, 8-bit interlaced     |                       758 MiB |

These are native `getrusage` process peaks, not total Lambda memory. The bounded
prototype's environment reached 1066 MiB including fixture generation. AWS
reports can retain an environment-lifetime high-water mark, so they must not be
attributed to individual later jobs. Sampled parent/child RSS can count shared
pages twice and is not an exact kernel peak.

There were 86 successful native resizes, two expected old-guard rejections and
one deliberate decoder termination at a lowered 512 MiB watchdog budget. Both
original-image sizes succeeded on the following request. All successful outputs
were fully decoded; original-image output hashes matched across repeated and
bounded runs. Original resize time was 2.15–2.20 seconds for 450 and 2.37–2.46
seconds for 1080, excluding module initialization, verification and S3 latency.
Temporary functions, logs, role, bucket, source copies and fixtures were deleted.

## Enforced envelope

- Source: 256 MiB, also used by upload acceptance; at most 100,000 pixels on
  either input side. 8-bit PNG admission is at most 100 million pixels;
  16-bit is at most 64 million. Other depths are rejected.
- Preview: at most 4096 pixels on either side, two million pixels total and
  10 MiB encoded. Ordinary requested fit/orientation/no-upscale behavior is
  preserved when already bounded. Oversized results fit inside a reduced box.
  A 100,000 by 100 source otherwise remained 100,000 pixels wide even for an
  `AUTOx450` request; the bounded prototype returned 4000 by 4.
- Execution: one native resize per child, one libvips thread, no operation
  cache, 256 MiB JS heap, 30-second lifetime with upload reserve, and a sampled
  1 GiB combined parent/child RSS watchdog. The child reports total RSS over a
  dedicated pipe, including Sharp's native memory. The parent fails closed on
  missing/invalid reports and waits for child exit before releasing its files.
- Output is fully decoded within its bounded pixel budget before use. Original
  privacy stripping runs separately in a child, preserving oriented dimensions;
  it uses the source-byte ceiling rather than preview dimensions.

The RSS watchdog is not a hard native allocation limit: allocations can grow
between reports. The Lambda allocation is the hard boundary. Input/output limits
and headroom are necessary even with process isolation. Codec, metadata, depth,
interlacing and version changes require reviewing the measured envelope; these
tests do not assert identical memory use for every malformed file or ICC profile.

Confirmed invalid input and explicit source/pixel/output limits are permanent
input errors. Worker startup, memory/deadline termination, monitor failures,
filesystem and S3 failures remain operational. Resource failures do not create
permanent on-demand rejection markers. Upload processing retries operational
failures and never marks an incomplete image ready.

## Publication and recovery

Both standard legacy derivatives are generated before any public upload. The
original and derivatives must all be stored before `ready`. Ingest deletion
occurs only after the ready-state database write succeeds, so a failed state
commit can retry from the private source. Deletion is best effort; ready-message
redelivery retries it without rendering or changing upload state. Without
redelivery, a failed delete leaves private bytes for the ingest retention policy.
A storage failure may leave partial objects, but the upload remains processing
and retryable; retry re-renders both previews and overwrites the same task-owned
keys, including an already-written original. This deliberately accepts repeated
work rather than trusting a bare HEAD/exists result that cannot prove the source
revision and rendering policy match. Permanent failure can leave partial public
objects; readiness remains gated on all three successful writes. No global cleanup
deletes other requests' files. Metadata-disabled originals retain their exact bytes,
including interlaced 16-bit PNGs; derivative encodings are not canonical originals.
Originals retain immutable caching. Previews use the on-demand resizer's one-day
cache policy, and shared-key parity is checked for JPEG, PNG, WebP and GIF.

The sanitizer reserves 1 GiB ephemeral disk for source, optional sanitized original
and both previews. On-demand resizing retains its existing temporary disk size.
All upload formats stream into the owning temporary directory. JPEG/WebP/GIF
sanitization and AVIF conversion read and write files rather than retaining full
source and encoded buffers in Node. JPEG/WebP/GIF previews retain their existing
codec admission and GIF still-frame fallback. Optional original re-encoding must
fit the conservative full-decode budget; it cannot claim preview decoder shrink
or discard GIF frames. File I/O failures remain operational.
The unchanged 900-second Lambda timeout bounds the entire message, including
S3 operations; the unchanged 930-second SQS visibility exceeds that hard limit.
PNG processing uses at most three sequential 30-second child deadlines. Stalled
storage can still exhaust the invocation and cause replay, so no total latency
promise is inferred from those child deadlines. The 20-minute database claim
prevents a concurrent redelivery from taking a live claim; a terminated attempt
can therefore wait for claim expiry before rendering again.
The legacy GIF keys provide the frontend fallback when a versioned animation
request cannot be rendered.

Existing ready uploads are not requeued or changed. The corrected on-demand PNG
path can generate their missing derivative keys without a re-upload or changed
drop URL. Production generation is a separate authorized action; local output
verification does not claim that existing production derivatives were repaired.

When rollout is authorized, deploy `mediaResizerLoop`, then `dropMediaSanitizer`.
The existing API/status contract is unchanged; no API deployment, schema change
or new service is needed.
Rollback must retain preview-capable processing for queued uploads and preserve
already written originals/derivatives.
