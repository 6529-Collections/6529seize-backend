# Reusable artwork and museum records

`stream_artwork_basic_v1`, version 3, is the shared museum record profile. A caller
provides work/NFT references and the artist chooses the applicable media. Keys and
Gates uses this same profile; a server-owned program binding supplies its fixed
CC0 terms and source Wave. There is no separate photographic intake implementation.

## Record and editing contract

The eight existing module envelopes remain stable. Typed structures represent
people and organizations, software, places, works and components, physical
objects, documents, interviews, measurements, events and relationships. IDs remain
distinct: a token, a work, a received master and a physical print are different
subjects. Ten composable media modules cover photography, still digital art,
video, audio, HTML, generative software, interaction, spatial work, text and
installation. Media changes retain prior writing.

Catalogue field metadata supplies language, examples/guidance, nested editors,
applicability and conditional requirements. Artists write ordinary descriptions;
museum staff reconcile proposed authority matches with evidence. Artist claims,
file measurements, institutional assertions and future chain proofs never inherit
one another's authority.

Drafts use optimistic version checks, idempotency keys and the existing context
lock. Version 3 checks the complete context (answers, linked file snapshots and
profile), including JSON escaping in a Lambda proxy response, against its
4,000,000-byte budget. It rejects oversized writes without truncating writing.
File lists omit detailed technical metadata; an authorized single-file read loads
the bounded summary when requested. An available shared artist record is a
deferred reference in v3 context responses. Read
`GET /artwork-documentation/contexts/{id}/artist-records/{revisionId}` to compare
the complete version before pinning it. That read belongs only to the artist.

Version 1/2 meaning and confirmed hashes are preserved. A profile upgrade has an
explicit preview, retained-field report and blocking disclosures; applying it
does not reconfirm the result. New v3 material is intended for publication. Team
questions are separate discussion records and never enter the publication dossier.
Previously restricted originals are not reclassified by attaching them to v3.

## Materials and processing

The material library distinguishes received originals from described material
that has not been supplied. A file may have several roles without duplicate
upload, and relationships connect source, master, derivative, transcript and
component. It accepts batch/resumable transfers with 8 GiB per file, 128 GiB per
context and 1,000 files/links, subject to context metadata and processing limits.
The context quota is locked before allocation. Sizes use safe numeric conversion
from database BIGINT values.

Every path retains the website's clean-only malware gate and applicable complete
PDF validator. ZIP processing is bounded and rejects unsupported nesting,
encryption, ambiguous paths and invalid member structure. Original bytes remain
unchanged. Technical characterization can be partial or unavailable without
inventing measurements. PRONOM claims require an actual pinned signature match.
Content Credentials are read in a separate bounded-lifetime process with remote
fetch and trust assertions disabled. Signed, unsigned and tampered fixtures cover
the distinction between media integrity and issuer trust.

Audio/video previews use only allowlisted, scanned passive media. HTML, scripts,
software packages and models are retained as originals; the application does not
execute them in its own origin. See
[specialist processing](artwork-specialist-material-processing.md) for format,
capacity, runtime and parser limits.

## Museum journal

The museum-record API offers typed, immutable records for catalogue notes,
authority alignment, acquisition, accession, custody, condition, exhibition,
loans/returns, preservation, citations, rights, valuation, stewardship, recovery,
deaccession and redemption. The server assigns the authenticated recorder, time,
source draft/revision and evidence hashes. The assigned review lane controls
writing; program viewing does not grant mutation authority.

Corrections append a same-kind superseding record. Earlier assertions and their
evidence remain available. Local condition references must resolve to condition
records in the same context. Recording an institutional event does not alter the
artist draft or its confirmation. A database account receipt is not a wallet
signature, accession instrument, title transfer or proof of physical delivery.

## Portable dossier and standards

An authorized dossier inspection returns readiness issues and a file manifest.
Export creation binds the exact source digest and draft version, then queues a
worker job. The worker streams original bytes through size/SHA-256 checks and
multipart upload. A completed export has an immutable object version and archive
digest. Download permission is freshly checked and the signed URL lasts 60 seconds.
Exports expire after seven days; the source originals are unaffected.

The package is an OCFL 1.1 object containing a BagIt 1.0 bag. It contains the
complete source record, original files, all public artist confirmations, review
history, source receipts, institutional journal, C2PA evidence, mappings and
pinned schemas. Originals referenced by earlier confirmations or museum evidence
remain included even after they leave the current draft. Restricted historical
snapshots retain their original ID/hash but their bytes are excluded from this
publication package.

Mappings include:

- Linked Art/CIDOC: distinct entities, scoped events and attributed assertions.
  Reviewed, evidenced, uncontested authority matches can supply equivalence;
  disputed or withdrawn matches remain separate statements.
- LIDO 1.1: work, component, object, document and file records; languages,
  descriptive writing, participant roles, dates, event places and dimensions
  scoped separately to image, sheet, object or digital file.
- PREMIS 3.0: intellectual objects/files, agents, rights, fixity/format results,
  significant properties and technical/institutional events. Plans are not
  represented as completed preservation actions.
- IIIF Presentation 3: ordered scenes, image/video/audio painting, layout, clips,
  time modes, transcripts, captions and annotations. Other originals are linked
  as renderings. Ambiguous timing is retained without invented alignment.

IIIF uses an explicitly unserved `example.invalid` publication base plus an exact
local binding map. A later publication adapter supplies permanent URLs. This is
not a deployed IIIF service. No export operation registers a Stream subject,
publishes to IPFS/Arweave, signs a wallet message or mints a token.

`reconstructDossier` verifies the complete OCFL physical manifest, inventory
copies and BagIt payload/tag digests, then reconstructs the source and museum
records without the application database. It restores neither permissions nor
signature authority. Importers must treat original files as untrusted input and
reuse normal authorization, upload scanning and explicit artist review when
creating live application records.

## Verification and rollout

Focused tests cover all ten media and combinations, the supplied AN ALTERATION
source, source retention, role boundaries, immutable evidence, timing and package
reconstruction. The independent Python validator checks actual exported XML
against the locked LIDO/PREMIS schema closure, IIIF against its pinned upstream
JSON Schema, and every BagIt/OCFL digest. It performs no network or database reads.

Deploy `artworkDocumentationStorage` and `dbMigrationsLoop` before
`artworkDocumentationProcessor`. Deploy `attachmentsProcessor` for the shared PDF
validator, then `api`, followed by the dependent frontend.
The new entities and asset columns are applied by the existing TypeORM schema
sync. Use the normal [deployment process](deployment.md) and repeat the upload,
read/review, export and hash checks in each authorized environment. Local parser
benchmarks are not evidence of AWS upload or GuardDuty throughput.
