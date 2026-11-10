# Artwork publication bridge (IIIF Presentation 3)

The dossier exporter already compiles a draft IIIF Presentation 3.0 manifest
under the unserved `example.invalid` base (`museum/export/iiif.ts`). The
publication bridge is the adapter that draft was waiting for: it binds the
draft to permanent URLs, adds rights, attribution and museum resource roles,
stores the result as an immutable versioned row, and serves it from a public
read route. Nothing here mints, pins, signs or hosts media.

Code: `src/artwork-documentation/museum/publication/`.

## Compile inputs

`compilePublication(input)` (`publication-compiler.ts`) is a pure function of:

| Input              | Meaning                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`         | The verified `DossierSnapshot` (context, assets, museum records, confirmed revision) exactly as the dossier service loads it.                                                                            |
| `source_sha256`    | Must equal `dossierSourceHash(snapshot)`.                                                                                                                                                                |
| `selection`        | Explicit asset ids approved for public presentation. Each must exist, be `public_record` on both the asset and its link, and must not be `rights_evidence`.                                              |
| `bindings`         | `base_url` (https, no query/fragment/credentials, path of conservative identifiers such as `https://6529.io/iiif/objects/<object-id>`), `media` (https URL per selected asset), optional `homepage_url`. |
| `rights`           | `rights_uri` from the museum rights registry copy (`publication-rights.ts`, registry 1.1.0, sha `fd627ff3…`), a `required_statement` (label + value), optional `provider` (https id + label).            |
| `roles`            | One museum resource role per selected asset: `authorized_manifestation`, `documentation_surrogate`, `preservation_master`, `access_derivative`, `live_upstream_service`, `technical_model`.              |
| `compiler_version` | Must equal `PUBLICATION_COMPILER_VERSION`.                                                                                                                                                               |
| `produced_at`      | Optional caller timestamp. The compiler never reads the clock.                                                                                                                                           |

The compiler calls `buildIiif(context, selectedAssets, draftBase)` (the same
compiler the dossier uses, restricted to the selection), decorates the result,
and rewrites every draft URL: `<draft>/originals/<asset>` becomes the bound
media URL and every other `<draft>/...` id is rebased onto `base_url`.

Output: `manifest`, `source_sha256`, `manifest_sha256` (SHA-256 of the RFC 8785
canonical JSON, the same canonicalisation as `dossierSourceHash`),
`transformation` (`compiler_version`, `input_digest` over the full input with
the selection sorted, optional `produced_at`, the draft compiler's `issues`)
and `validation` (the structural self-check from `publication-validation.ts`).

Manifest members: `@context` first, `id = <base>/manifest`, `label`, `summary`
(from the caption), `metadata` (record status, source digest, compiler, one
"Resource role" entry per selected asset, "Documentation surrogate" and "Live
work" statements when applicable), `requiredStatement`, `rights` (http form of
the registry URI, which the official IIIF schema requires), `provider`,
`homepage`, `seeAlso` (`<base>/source`, type `Dataset`), `thumbnail` (first
measured still image), `rendering` (every selected original labelled with its
role, plus the live upstream URL) and `items` (canvases).

Surrogates: a canvas painted by a `documentation_surrogate` is relabelled
"… — documentation surrogate (captured <date>)" when the asset's technical
metadata carries `properties.capture_date` or `date_time_original`, gains a
"Documentation surrogate" metadata entry and, when the work has a live
upstream URL, a `rendering` labelled mutable. The live upstream URL is read
from `context.sources` entries of kind `artwork` with an https `url`. A still
image of a generative, interactive or HTML work cannot be an
`authorized_manifestation`.

## Rejections

Input problems throw `PublicationRejectedError` with one of the codes in
`PUBLICATION_REJECTION_CODES`: `SOURCE_HASH_MISMATCH`, `EMPTY_SELECTION`,
`DUPLICATE_SELECTION`, `UNKNOWN_ASSET`, `PRIVATE_ASSET`,
`RIGHTS_EVIDENCE_ASSET`, `MISSING_ROLE`, `UNSUPPORTED_ROLE`,
`ROLE_NOT_SELECTED`, `INCONSISTENT_ROLE`, `INVALID_BASE_URL`,
`INVALID_HOMEPAGE_URL`, `MISSING_MEDIA_BINDING`, `INVALID_MEDIA_URL`,
`BINDING_NOT_SELECTED`, `RIGHTS_URI_NOT_IN_REGISTRY`, `ATTRIBUTION_REQUIRED`,
`INVALID_PROVIDER`, `NO_PRESENTABLE_CANVAS`, `UNSUPPORTED_COMPILER_VERSION`.
The service maps `SOURCE_HASH_MISMATCH` to `409 DOSSIER_SOURCE_CHANGED` and
every other code to `422 <code>`.

Determinism: the same input, with any object key order and any selection
order, produces byte-identical canonical JSON and identical digests
(`publication-compiler.test.ts` checks this with fast-check).

## Service, versioning and traceability

`publication.service.ts` reuses `authorizeContext` and the dossier export gate
(`requireExportAccess`: artist or full archival capabilities, version 3
publication-only profile, no restricted paths, everything `public_record`),
then inside the idempotent transaction (context row locked, `If-Match` draft
version checked) loads the dossier snapshot and additionally requires a
confirmed revision that is current (`confirmation === 'current'`) and
internally consistent (`sha256 === digest(snapshot_json)`), and that the
request's `source_sha256` equals the snapshot digest.

Rows in `artwork_documentation_publications` (`ArtworkPublicationEntity`):
`id`, `context_id`, `revision_id`, `actor_profile_id`, `version` (1, 2, … per
context), `state` (`published` | `withdrawn`), `source_sha256`,
`manifest_sha256`, `input_digest`, `manifest_url`, `input_json` (the request:
selection, bindings, rights, roles, source digest), `manifest_json` (canonical
JSON), `compiler_version`, `storage_key`, `created_at`, `withdrawn_at`.

Publishing is idempotent on the `Idempotency-Key` and, independently, on
`(context_id, source_sha256, input_digest)`: identical input for the same
verified source returns the existing published row instead of a new version.
Any change to the source or to the bindings/rights/roles produces version
`n + 1`. Withdrawal sets `state = withdrawn`; it never deletes.

Audit events: `artwork_publication_created`, `artwork_publication_withdrawn`.

## Serving and CORS

- `POST /artwork-documentation/contexts/{id}/publications` (auth, `Idempotency-Key`, `If-Match`) compiles and stores; returns `ApiArtworkPublication`. The generated router only types a `200` response, so the create route answers `200` with the publication body rather than `201`.
- `GET /artwork-documentation/contexts/{id}/publications` (auth) lists versions, newest first.
- `POST /artwork-documentation/contexts/{id}/publications/{publicationId}/withdraw` (auth, `Idempotency-Key`).
- `GET /museum/iiif/{publicationId}/manifest` — public, `auth: none`, `cache: true`. It is deliberately outside the `/api/artwork-documentation` prefix whose CORS is restricted to credentialed web origins (`api-constants.ts`), so the default wildcard CORS applies and IIIF viewers on any origin can load it. The handler sets `Content-Type: application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"`, `Cache-Control: public, max-age=300` and `nosniff`; only JSON is served from the API origin, never artwork HTML or scripts. Withdrawn publications answer `410 PUBLICATION_WITHDRAWN`; unknown ids `404`. The shared request cache may keep a withdrawn manifest for its TTL.

`ApiArtworkPublication.manifest_url` is the permanent bound id
(`<base_url>/manifest`); `manifest_api_path` is the API origin path. Routing the
permanent URL to the API or to the stored copy is edge configuration that this
change does not provision.

The public read depends only on the publication row. Dossier export downloads
(presigned, 7-day expiry) are unrelated; the DB test proves an expired export
does not affect the manifest.

Optional immutable copy: when `ARTWORK_PUBLICATION_BUCKET` is set,
`publication.storage.ts` writes the canonical manifest to
`museum/publications/<publication_id>/<manifest_sha256>/manifest.json` with
`Cache-Control: public, max-age=31536000, immutable` through `s3UploadObject`
and records the key. Failures are logged and do not fail the publication. No
bucket, CloudFront distribution or domain is provisioned here.

## Fixtures, goldens and validation

- `src/artwork-documentation/museum/fixtures/publication-fixtures.ts` builds four cases on the museum corpus: still image (`digital_art`), timed media (`video`), multipart (installation + photography + audio + spatial with declared scenes) and a generative work documented by a dated still (`documentation_surrogate` with a live upstream URL).
- Committed goldens: `src/artwork-documentation/museum/fixtures/publication/*.json` and `digests.json`. Regenerate after an intentional compiler change with `./bin/6529 exec ts-node --transpile-only -r tsconfig-paths/register scripts/write-museum-publication-goldens.ts`.
- `publication-schema.test.ts` validates all four manifests against the pinned upstream schema (`export/schemas/iiif-presentation-3.json`) with ajv 6 (draft-07).
- Independent Python check: `./bin/6529 exec ts-node --transpile-only -r tsconfig-paths/register scripts/write-museum-corpus.ts` now also writes `publication-<case>.json`; `python scripts/validate-museum-corpus.py .museum-corpus-fixtures` validates them against the same pinned schema and checks rights, required statement, canvases and the absence of the draft base.
- Manual viewer check (not CI): `python3 -m http.server 8787` from the repository root, then open `http://127.0.0.1:8787/scripts/museum-publication-viewer.html?manifest=/src/artwork-documentation/museum/fixtures/publication/still-image.json`. Mirador loads from its CDN; fixture media hosts are placeholders and will not resolve.

## Not done

- No CloudFront, bucket, domain or edge routing for `https://6529.io/iiif/...`; `manifest_url` is a bound identifier, not a provisioned endpoint.
- No media hosting: callers supply already-public media URLs; nothing is copied out of the private archive.
- No production publication of real artwork; fixtures are synthetic.
- No IIIF Image API services, Collections or Ranges.
- The official hosted IIIF validator and a browser render are manual steps.
- Frontend OpenAPI synchronisation is a separate task.
