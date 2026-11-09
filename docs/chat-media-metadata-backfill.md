# Chat media metadata backfill

New chat uploads have identifying metadata stripped when they are published
(see [image upload format validation](image-upload-format-validation.md)).
This operator tool applies the same lossless strip to chat images that were
already published before that. Decision entries keep the artist's original
bytes and are never touched.

It replaces `src/dropMediaSanitizer/backfill-existing-drop-media.ts`, which
selected every drop and wave image including decision entries, overwrote in
place without a copy and could fall back to a lossy re-encode.

Nothing runs automatically. The tool is a local CLI started by an operator
with the owner's approval; deploying this code changes nothing.

## What counts as chat media

The selection is computed from the database the run is configured for:

1. **Candidates.** Rows of `drop_medias` with an `image/*` (rewritten) or
   `video/*` (counted only) MIME type whose URL is on the media CDN under
   `drops/` or `waves/`, joined to their drop; plus wave pictures
   (`waves.picture` and `waves_archive.picture`) under `waves/`. Other hosts
   (IPFS, Arweave) and prefixes are counted as out of scope.
2. **Chat.** The drop exists, its `drop_type` is `CHAT` and it has no
   `competition_entries` row. Replies and drops in direct-message waves are
   chat (the owner rule covers chat drops, replies and DMs); the report
   counts them separately. Wave pictures are chat.
3. **Excluded: decision entries.** A decision entry is a participatory drop
   that is not a reply. Winners and native competition submissions are
   decision entries too, as is every drop with a `competition_entries` row
   (withdrawn and disqualified entries included). Before scanning, the tool
   builds an index of every object key such a drop uses, and skips any
   candidate with a key in it, so a chat drop reusing a decision-entry URL is
   skipped too. The index holds:
   - the entry's own `drop_medias` URLs;
   - every `drops/` or `waves/` key written anywhere in its
     `drops_metadatas` values, which includes the Memes `additional_media`
     JSON (`artist_profile_media`, `artwork_commentary_media`,
     `preview_image`, `promo_video`), in its parts' content, and in its
     native entry content history (`competition_entry_content_versions`).
     A key cut short in text (a file name with a space or bracket) excludes
     every key it is a prefix of, down to the whole upload folder;
   - every `drop_media_uploads.public_key` whose `purpose` is
     `decision_entry`;
   - claim artwork URLs in `minting_claims`.
4. **Skipped as ambiguous and reported:** media rows whose drop no longer
   exists, uploads with an unknown purpose, non-chat replies (no current flow
   creates them), unknown drop types, and wave pictures outside `waves/`.
5. **Shared bucket guard.** Staging and production share the public bucket
   and CDN. Outside production, only keys that have a `drop_media_uploads`
   row in that environment's database are touched; local runs cannot write.

During an execute run, decision entries created since the index was built are
read again at most once a minute, before each page is classified.

## What a run changes

Each selected image is read and parsed first:

- No identifying metadata (nothing to strip, Orientation only, or EXIF with
  only layout and colour tags such as resolution and colour space): left
  alone, with no write and no CDN invalidation.
- Identifying metadata: the bytes are stripped with
  `stripMetadataWithPixelCheck` (`src/media/metadata-strip/`), which copies
  image data verbatim and must prove the same size, orientation, render
  stream and decoded pixel hash. HDR gain maps are kept and their pixels
  verified as well.
- Skipped and listed, never re-encoded: files that do not verify, files whose
  HDR gain map would be dropped, unsupported containers (AVIF, HEIF, TIFF,
  SVG), objects over 64 MiB, `Content-Encoding` objects and missing objects.

The report counts files per category without recording any value: `gps`,
`serial` (body, lens and camera serials, image IDs, maker notes),
`owner_artist`, `capture_time`, `thumbnail`, `xmp_iptc`, `camera` (make and
model), `other` (comments, text chunks, software, trailing data) and the
untouched states `no_metadata`, `orientation_only` and `technical_exif_only`.

A rewrite then:

1. writes the original, with its headers, to the private safety bucket and
   verifies its size and SHA-256 checksum;
2. writes a manifest next to it (key, original ETag, version ID, size,
   checksums, headers and CDN paths; no metadata values);
3. overwrites the same key only if its ETag still matches what was read,
   with the same `Content-Type`, `Cache-Control`, `Content-Disposition`,
   `Content-Language`, storage class and user metadata, plus
   `privacy-sanitized=true` and `metadata-backfill-run=<run id>`;
4. queues the object's CDN paths; invalidations are sent in batches of up to
   1,000 paths after each page and at the end of the run.

Derived previews were generated without metadata and are not rewritten.

Videos are not changed (phase 2 has no video stripper). A dry run counts chat
videos and, by default, reads at most 512 KiB from each end of each video to
count those likely to carry location (`©xyz`, Apple's ISO 6709 key, GoPro
GPMF).

## Safety copies

Originals go to the existing private drop-media ingest bucket
(`DROP_MEDIA_INGEST_S3_BUCKET`, or `6529-drop-media-ingest-<account>`) under
`<stage>/backfill-originals/<run id>/objects/<key>` and
`<stage>/backfill-originals/<run id>/manifest/<key>.json`. No bucket or
lifecycle rule is created. Before writing, the tool refuses to run unless that
bucket differs from the public bucket, blocks all public access and has no
expiration rule covering the prefix. The bucket's existing rules expire only
the `drop-media-ingest/` and `wave-media-ingest/` prefixes, so copies stay until
an explicit purge.

- `restore` puts originals back and invalidates the CDN. It only restores
  keys that still carry this run's marker, conditionally on their current
  ETag, after checking the copy against the manifest checksum.
- `invalidate` resubmits CDN invalidations for the run's keys, for example
  after an interrupted run.
- `purge-originals` deletes the run's copies older than `--older-than`,
  which must be at least `7d`.

The public bucket (`6529bucket`) has never had versioning enabled (read-only
check on 2026-11-09), so an overwrite leaves no retrievable older version. If
versioning is ever enabled, `purge-originals --delete-noncurrent-public-versions`
also deletes the noncurrent public version holding each original once the
safety period has passed; it refuses to run on an unversioned bucket.

## Running it

The tool runs locally from the backend repository root through the `6529`
wrapper, like the script it replaces: `ts-node` loads
`src/media/metadata-backfill/chat-media-backfill.cli.ts`, and the scan uses
`doInDbContext`, which reads `.env.<NODE_ENV>`. Every command is a dry run
unless `--execute` is passed, and `--environment` must match the loaded
configuration (`prod` for `NODE_ENV=production`, `staging` for
`development`).

The configuration needs the database credentials (read-only queries),
`S3_BUCKET` and `S3_REGION` for the public bucket, and the ingest bucket
variables. The AWS credentials need, on the public bucket, `s3:GetObject`,
`s3:PutObject` and `s3:GetBucketVersioning`; on the ingest bucket's
`<stage>/backfill-originals/` prefix, `s3:PutObject`, `s3:GetObject`,
`s3:DeleteObject` and `s3:ListBucket`, plus `s3:GetBucketPublicAccessBlock`
and `s3:GetLifecycleConfiguration`; and `cloudfront:CreateInvalidation` on
the media distribution. The Lambda role's ingest permissions do not cover
this prefix.

```bash
# Read-only: counts, skip reasons and estimated bytes for the whole set
NODE_ENV=production ./bin/6529 run drop-media:backfill -- scan --environment prod --dry-run --report scan-dry-run.json

# Read-only: 50 random chat images with their categories, for hand checks
NODE_ENV=production ./bin/6529 run drop-media:backfill -- scan --environment prod --dry-run --sample 50

# Rewrite a random sample, or the first N, then hand check; note the run id
NODE_ENV=production ./bin/6529 run drop-media:backfill -- scan --environment prod --execute --sample 20
NODE_ENV=production ./bin/6529 run drop-media:backfill -- scan --environment prod --execute --limit 500 --run-id <run id>

# Full run, resumable from the report's next_cursor; keep one run id
NODE_ENV=production ./bin/6529 run drop-media:backfill -- scan --environment prod --execute --run-id <run id> --concurrency 4 --resume-after <next_cursor>

# Undo (all keys, or one), resubmit invalidations, purge after the safety period
NODE_ENV=production ./bin/6529 run drop-media:backfill -- restore --environment prod --run-id <run id> --execute
NODE_ENV=production ./bin/6529 run drop-media:backfill -- restore --environment prod --run-id <run id> --key <public key> --execute
NODE_ENV=production ./bin/6529 run drop-media:backfill -- invalidate --environment prod --run-id <run id> --execute
NODE_ENV=production ./bin/6529 run drop-media:backfill -- purge-originals --environment prod --run-id <run id> --older-than 7d --execute
```

Other options: `--concurrency` (1-8, default 2), `--page-size` (default 500),
`--no-video-probe` and `--report <path>`. Run one scan at a time; conditional
writes keep concurrent runs from overwriting each other's results. A scan
saves its report after completed pages (at most every 15 seconds) and at the
end, and stops after 25 consecutive
object failures (for example missing permissions), so `next_cursor` survives
an interruption; `invalidate` resubmits any CDN paths a stopped run did not
send.

The JSON report (default `drop-media-backfill-<command>-<run id>.json`)
contains counts, object keys and reasons only: selection counts (chat images
and videos, DMs, replies, duplicates, out of scope), exclusions and ambiguous
keys by reason, category counts, objects inspected, to rewrite, rewritten,
unchanged, skipped and failed (with keys), HDR gain maps kept, bytes
downloaded and to rewrite, video counts, CDN invalidations, samples and
`next_cursor`. Key lists stop at 10,000 entries per list.

## Limits

- A decision entry that was deleted leaves no record of its type; a chat drop
  that reused its URL is only protected if the upload recorded
  `purpose = decision_entry`.
- Between index refreshes (up to a minute), a new decision entry could reuse
  an existing chat URL before the run reaches it.
- CDN invalidation does not clear copies already cached by browsers or other
  caches under the immutable cache policy, and IPFS or Arweave pins cannot be
  changed.
- Videos, E2EE message attachments (client-encrypted) and profile pictures
  are outside this tool.
