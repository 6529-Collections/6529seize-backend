# Private artwork documentation

The authenticated `/api/artwork-documentation` boundary stores modular artist
documentation in MySQL and private original files in dedicated S3 storage.
Artists can start during a Wave submission or return afterward. Documentation
does not replace, submit, delete, sign or vote on the original Wave drop.

All access is private. `public_record` is an intended future disclosure choice,
not publication permission. This release performs no mint, token allocation,
on-chain transaction, IPFS upload or Arweave publication. Artist confirmation is
a dated authenticated database receipt, not a wallet signature, copyright
instrument, Museum accession decision or assertion of legal ownership.

## Application contract

The canonical API contract is `src/api-serverless/openapi.yaml`; generated
models and route wiring are refreshed through `generate:openapi`. Eight module
catalogues, including JSON Schema value descriptors and bounded field statuses,
are returned by `GET /artwork-documentation/profiles`. The controlling identity
is the actual authenticated profile, never a mutable handle or proxy role.

Every content change compares the single context `If-Match: "draft-N"` version
inside a write-pool transaction. All mutation requests have an idempotency UUID.
An actor/route/key identifies a request digest and durable result reference,
which is reprojected under current authorization on retry. Keys are retained
for at least seven days; permanent source and revision uniqueness are separate.

The context's JSON stores the eight modules and asset-role links. Shared artist
identity has independent immutable revisions; context-only contact details never
enter those shared records. Updating identity compares both context and artist
record versions. Other contexts retain their pins until an artist adopts an
available version. Confirmation locks the context, validates required fields
and ready assets, and atomically writes a revision, receipt, pending review lanes
and an event. A snapshot normalizes strings to NFC/LF before RFC 8785-compatible
canonical JSON and SHA-256. Source receipts retain their separate original
bytes and hashes. Digests establish byte equality, not truth or authorship.

The three review lanes refer to one immutable revision. Later draft edits do
not overwrite an earlier confirmation or carry acceptance into a new revision.
Rights-sensitive fields, private contact, source receipts and original-file
access are separately permissioned. Context and program grants do not confer
artist confirmation authority. Artists can invite documentation editors;
program coordinators assign reviewers. Artists cannot appoint institutional
reviewers and coordinators cannot assign themselves extra evidence access.

Coordinator queues filter confirmation state, review lane, outstanding action
and pinned profile before cursor pagination. Queue summaries contain lane status
without private review reasons. A profile pins the exact eight interview prompts
alongside its instrument ID, version and language. Recording and transcript
references require participants, date and explicit disclosure permission. The
basic profile uses curatorial and rights lanes; photography and Keys and Gates
also require technical review.

Original files and their processing/storage operational requirements are in
[the archive operations guide](artwork-documentation-assets-operations.md).
Content links use the most restrictive disclosure already selected for the
same asset, including historical restrictions. Broadening historical asset
access is intentionally unavailable through a role-link edit. Ordinary review
participants receive authorized safe previews, not original-byte URLs.

## Deployment and activation

Deploy additive TypeORM tables with `dbMigrationsLoop`; no SQL schema migration
or foreign key is introduced. Deploy the storage infrastructure, processor and
API in the dependency order in the archive operations guide. Core runtime
flags are `ARTWORK_DOCUMENTATION_ENABLED` and
`ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED`; both default off. Environment
specific deployment variables are documented in that guide. Keep self-service
off for the commissioned-program pilot, and enable the overall feature only
after tables, private storage and malware verification are operational.

The API disables cache/storage publication semantics on these routes. Approved
web origins may send `If-Match` and `Idempotency-Key`; ETags and request IDs are
exposed for client recovery. Duplicate JSON keys are rejected before parsing.
The private boundary strips request answers from error integrations and does
not log query strings, filenames, source text or signed URLs. No session replay
or analytics payloads should be enabled in the corresponding frontend.

## Keys and Gates onboarding

The operator command is dry-run by default. It verifies all 16 known source
drop IDs against the database's author and the configured program Wave before
any mutation. The coordinator's stable profile must already exist in the target
environment. The command never derives reviewer privileges from Wave roles,
voting activity or Drop Forge administration.

```bash
6529 exec ts-node -r tsconfig-paths/register src/artwork-documentation/artwork-documentation-pilot.ts --coordinator-profile-id <verified-profile-UUID>
6529 exec ts-node -r tsconfig-paths/register src/artwork-documentation/artwork-documentation-pilot.ts --coordinator-profile-id <verified-profile-UUID> --apply
```

The apply action explicitly grants that coordinator ordinary program management
access, then creates each artist-owned context through the same idempotent
domain service. It imports source receipts without silently treating them as
artist-confirmed answers. Artists use the source preview, choose fields and
review any proposed source language. Re-running the command recovers existing
contexts instead of duplicating works. Output contains IDs only. No invitation,
email, Wave post, wallet action or payment is sent by this command.

### Operator access inside the VPC

The dedicated `artworkDocumentationProcessor` also accepts two closed actions
through IAM-authorized Lambda invocation. It has no HTTP operator endpoint. Keep
Lambda invoke access limited to release operators, with invocation audit logging
configured by the deployment owner. Applied actions record the supplied UUID correlation ID in the
documentation event table. Neither action changes process environment variables
or enables the API's feature flags. Normal scheduled events still run only the
archival processor and operational metrics.

```json
{"operator_action":"import_keys_and_gates_v1","correlation_id":"<request-UUID>","coordinator_profile_id":"<verified-profile-UUID>","apply":false}
```

Imports default to read-only dry-run; only explicit boolean `apply: true` applies
the code-pinned roster. The processor uses the same import validation as the CLI.
No caller-supplied roster, program, SQL or grant configuration is accepted.

Missing source drops abort the import before any grants or workspaces are
written. The operator reports `KEYS_AND_GATES_SOURCE_DROPS_MISSING` with all
missing roster IDs, the `dry_run` or `apply` mode and the operator correlation
ID in Sentry's `artwork_documentation_import` context. The invocation still
fails; it is not treated as a successful or partially applied import. This is
operator-only diagnostic information; public API errors remain generic.
Staging does not contain the production commission sources, so running the
production roster there can produce this validation error.

```json
{"operator_action":"create_smoke_context_v1","correlation_id":"<request-UUID>"}
```

The smoke action resolves the existing `punk6529bot` profile in the target
database and creates one empty basic nonprogram context. Reuse the same
correlation ID to recover the same context after an uncertain response. It
creates no source records, shared identity edits, files or program grants, and
returns only identifiers. It works while API features remain disabled; the API
must be enabled independently after deployment verification before the bot can
exercise that context with its normal authenticated requests.

## Retention and recovery

Archiving is reversible and does not remove revisions. Asset replacement or
detachment does not erase an earlier confirmed original. No artist-facing
permanent deletion is available. An authorized deletion request must inventory
the context, shared artist revisions, private originals, confirmation history,
source receipts and backups before using an approved support operation; do not
silently rewrite immutable snapshots. Existing database/private-storage backup
owners must record a sample restore and hash verification before pilot intake.
Do not promise permanent preservation or a new retention period from this code.

Validation covers strict field/status/date/Unicode rules, cross-profile and
proxy denial, restricted projections, immutable revisions, idempotency, stale
concurrent writes, shared identity pins and archive/restore behavior. Database
tests use the repository's isolated MySQL harness; they must never target shared
development or production data.
