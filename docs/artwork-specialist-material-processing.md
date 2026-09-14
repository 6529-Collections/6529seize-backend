# Specialist artwork materials

The generic version 3 documentation profile adds composable media capabilities. The context service derives the active media profiles from the validated saved `artwork.media_profiles` answer. Upload JSON cannot grant a capability. Photography, HTML and interaction can apply together; a program's eligibility and rights terms remain separate.

Legacy contexts retain their previous accepted extensions, final-image restrictions and disclosure rules. Version 3 accepts explicitly public camera originals and working projects, alongside print outputs, profiles, presets, source code, dependencies, environments, reference captures, captions, notebooks and publications. New version 3 public consent and rights instruments are ordinary publication files and do not create restricted paths. Previously restricted legacy evidence remains restricted; upgrading a profile cannot silently publish it. Each logical asset link can select a different role for the same scanned uploaded asset; no duplicate bytes are needed for a final/preservation master.

## Transfer and scan boundary

The multipart service uses SHA-256 part checksums, idempotent resumable uploads, immutable S3 object versions, 16 MiB parts, 8 GiB per file, 128 GiB per context, 1,000 files/links and five simultaneous sessions. An 8 GiB original uses 512 parts, within the existing 1,000-part S3 list response. Database sizes/reservations use BIGINT; arithmetic remains below JavaScript's exact-integer limit. AWS currently documents a 100 GB scan-attempt limit, 100,000 extracted files and 100 nesting levels; those provider maxima are not application throughput guarantees. Single originals over 8 GiB require a worker-capacity extension; splitting a master is not equivalent to preserving it.

Source: [AWS scan quotas](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-quotas-guardduty.html), inspected 12 September 2026.

Every original is read only after its exact version has a `NO_THREATS_FOUND` scan verdict. Pending, failed, denied, unsupported and threat-positive scans never yield a ready asset. Attachment, original/report downloads and export attachment validation independently require the clean verdict. File format recognition, preview limits, C2PA and malware results remain separate.

## Format handling

`ARTWORK_FORMATS` is the explicit extension/MIME catalogue. In addition to existing still-image/RAW/Photoshop/PDF/text/audio/video formats it accepts Phase One IIQ, ICC/ICM, Capture One XML settings and SQLite sessions, ZIP/EPUB, HTML/SVG, web/source/shader files, JSON/XML/YAML, timed text, fonts, glTF/GLB/OBJ/Blender, WebAssembly, WebM/Ogg/Opus/AIFF, AVIF and OpenEXR. Names and content signatures must agree where a signature exists. Text is streamed through strict UTF-8 validation; XML document/entity declarations are rejected. There is no wildcard executable format or generic role that bypasses scanning.

Unknown specialist file types can be included as opaque members of a scanned ZIP. Their bytes, names and hashes are retained; the system does not assert that it understands their format. Known members receive applicable header, UTF-8/XML and PDF checks. Archives are never extracted into a filesystem or executed. Source code, HTML, SVG and WASM originals are always downloads with octet-stream/attachment responses, never active same-origin previews. Controlled interactive execution is a separate product capability.

## PDF parity and original fixity

Website attachments and artwork materials call `validatePdfContent`. The shared policy is 25 MiB / 100 pages, a valid PDF signature, parseable content, no encryption and no website-blocked active features. It checks complete parsed names, including objects decoded from object streams; image/content bytes and literal strings may mention those names without rejection. The pinned parser treats lowercase hexadecimal name escapes inconsistently, so ambiguous residual name escapes are explicitly unsupported rather than allowed to hide structural objects. The website preserves its existing normalized-publication behavior. Artwork documentation retains the original bytes and original SHA-256; normalization is a validation step and is reported without silently replacing a master.

## Packages

ZIP/EPUB inspection reads central-directory metadata with bounded S3 ranges and streams individual stored/deflated members. It records each member's SHA-256 and original internal path. Application limits are 2,000 entries, 8 MiB central directory, 4 GiB expanded content and 100:1 member expansion. Unsafe/absolute/traversal paths, Windows aliases, duplicate or conflicting paths, symbolic/special links, overlapping members, size/CRC mismatches and corrupt data are rejected.

Encrypted, nested, multipart and ZIP64 archives are explicitly unsupported. They are not treated as scanned success by this parser. An artist can provide unencrypted, non-nested packages and separate named packages/files. A package cannot hide a website-rejected PDF or external XML entity. No file is automatically opened, executed, installed or fetched from its dependency URLs.

## Characterization and credentials

MP4/MOV characterization reads at most 8 MiB of movie metadata plus a 64 KiB file-type box. Sample tables are checked against their encoded extents and constant-size samples cannot claim more bytes than the source file. MP4Box runs in a separate Node process with a 128 MiB V8 heap, a ten-second hard timeout and a 64 KiB output limit. Parser resource exhaustion produces incomplete characterization and leaves the clean original intact; no arbitrary sample-count or duration cap rejects a long work. The packaged worker includes the exact MP4Box dependency used by that child process.

The metadata record binds its measurements to the original SHA-256. It reports ICC header attributes, WAV/FLAC audio attributes, bounded MP4/MOV track metadata and image dimensions, sample depth and colour information where decoded. TIFF/BigTIFF directory inspection reads up to 4,096 first-image tags and hashes embedded ICC data up to 4 MiB without allocating pixel buffers; it distinguishes first-directory measurements from complete multi-image characterization. Selected PRONOM signatures use committed official snapshots with source hashes; unmatched formats remain unidentified, and header recognition does not become a full format-conformance claim. Image previews remain separate JPEG derivatives. The 256 MiB / 100 million pixel preview limits do not invalidate a safely scanned larger original, including the AN ALTERATION master specification.

The authorized `media` download variant allows browser-native playback of explicitly allowlisted passive audio/video types. It uses the exact scanned original version and repeats the original-access and clean-verdict checks. `has_media_preview` signals that delivery is permitted, not that every browser can decode that file's codecs. Active content is excluded. The `c2pa_report` variant is a download-only, authorized sidecar; neither preview path grants access to otherwise restricted originals.

Single-file detail and stored file-link manifests carry a technical summary bounded to 4 KiB, with the original complete metadata JSON's SHA-256 and byte size. Base fields, warnings and credential fields share that byte budget. File lists omit technical metadata and use a compact SQL projection, so they do not load every large report or multipart receipt just to display filenames. Opening a file's existing upload/detail endpoint loads its technical summary. Raw C2PA reports and full archive-member inventories remain in authoritative asset storage/export; summaries retain report hashes, integrity/trust state, inventory hashes and member/byte counts. Primary image/audio measurements receive priority when a large track list must be summarized. The runtime role can read/write `validation-reports/`; obsolete object versions expire after seven days while current evidence has no automatic expiry.

C2PA uses the pinned `@contentauth/c2pa-node` 0.9.5 reader in a separate process. The 60-second timeout and 256 MiB JavaScript heap bound its lifetime and JS report allocation. Remote manifest and OCSP fetches are disabled. There are no signing calls or inferred artist identities. Native integrity results, signer trust (`not_assessed`) and scanner results are distinct. Full SDK reports are stored as download-only sidecars, with media, report and settings hashes; reports up to 128 KiB are additionally included inline. Absence, unsupported formats and validator failures are explicit. No credentials are created for a file that lacks them.

The worker reserves 10 GiB temporary storage and 3 GiB memory for the 8 GiB upload cap. It spools only applicable files, deletes its own temporary directory and keeps originals unchanged. The Lambda artifact check runs the actual native C2PA reader from the extracted package with offline settings. The pinned SDK fixtures verify absent, valid embedded and tampered manifests; they are not evidence about an artist's work.

### Reproducible capacity evidence

Run the opt-in local benchmark through the repository wrapper:

```sh
./bin/6529 exec /usr/bin/time -v node --max-old-space-size=1536 -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/benchmark-artwork-assets.ts --write-8gib
```

On 12 September 2026, Linux/WSL Node 22.22.1 streamed an actual 8,589,934,592-byte file to disk and verified its SHA-256 in the same pipeline used by the worker. Bounded MP4 inspection read 871 bytes; the native C2PA reader returned its full report. The file is the official SDK initialization fixture plus inert `free`-box padding, so the changed fixture's integrity was correctly reported invalid. This stage took 38.0 seconds. A separately generated valid 14,204 × 9,472 RGB16 TIFF (807,241,984 bytes) took 5.8 seconds; our directory inspector read 166 bytes, Sharp independently confirmed `ushort` samples, and native C2PA correctly reported no manifest. The full command, including runtime startup, took 62.2 seconds with 187,776 KiB OS-reported maximum RSS and no swap. Temporary originals were deleted.

This is measured local CPU/disk/parser capacity, not a substitute for a staging S3-transfer and GuardDuty scan run. The service test also resumes 512 signed parts, rejects changed resumed checksums, verifies all completed part sizes, binds the immutable completed version and replays completion without duplicate writes. Separate database integration tests cover the 128 GiB reservation boundary and five-active-upload concurrency boundary. Larger files and more costly valid formats require their own measured runtime evidence before raising limits. AWS permits at most 10,240 MiB temporary Lambda storage: [Lambda ephemeral storage](https://docs.aws.amazon.com/lambda/latest/dg/configuration-ephemeral-storage.html).

The SQL tests ran against a separate MySQL 8.0.46 instance on loopback port 3307, using a disposable database and generated fixture credentials. They verify concurrent reservation and journal idempotency, transaction rollback when audit recording fails, permission revocation while a save waits for the context lock, immutable supersession, and exact export snapshot persistence. Shared development database contents were not used or changed.

## Export memory and institution records

Dossier inspection and creation read a consistent context-locked transaction. Before loading history or file payloads, SQL counts and measures their escaped row representations. The snapshot budget is 32 MiB, with explicit count limits of 1,000 confirmations/files and 10,000 museum records, source receipts and review rows. The service derives file IDs from current links, public confirmations and immutable journal evidence, and fetches only those originals. Oversized snapshots fail with `DOSSIER_RECORD_LIMIT`; writing and technical evidence are never truncated. Download-status reads exclude the large snapshot column. The worker verifies original/report bytes before completing its immutable archive, and each download repeats current access checks.

Museum records are immutable, attributed statements separate from artist confirmation. Their saves do not change the artist's draft version or reconfirm the artist's writing. Loan examination references must identify existing condition records in the same context. Journal pages contain at most ten records, with an explicit cursor; the response-size regression includes large escaped statements.

## Remaining capability boundaries

This processing lane does not by itself implement a universal PRONOM engine, full vendor project inspection, source-code execution, playable delivery derivatives for every codec, ICC profile conformance, or trusted signer assessment. The metadata exposes these distinctions so the museum record can assign and review the remaining work. It does not mint, upload to decentralized storage, invent archival receipts or confer physical custody.

## Interview publication clearance

Version 3 allows artists to upload and attach material before completing the
Conversation chapter. These are access-controlled drafts intended for the public
record. This staging step does not grant publication permission.

Artist confirmation and dossier export require every interview recording and
transcript file to be referenced by a typed interview session with publication
permission, or covered by an explicit publication grant whose subject is that
asset ID. A permission for another interview or for the artwork does not cover
the file. Transcript documents and caption files are resolved through their
session references. An explicit publication denial blocks clearance, and a
conditional grant must record its conditions. Both the attachment role and the
stored upload role are checked. Exports apply the same rule to originals retained
by historical confirmations or journal evidence, including files unlinked from
the current draft. The history remains unchanged; a missing grant is reported
as an export-blocking issue. Version 1/2 retain their existing upload/link
permission gates.
