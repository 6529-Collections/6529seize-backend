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
Legacy rights-sensitive fields, private contact, source receipts and original-file
access are separately permissioned. The optional `read_restricted_fields` grant
adds access to other restricted answers and their historical projections. Its
absence means false. It does not confer contact, locked rights-evidence,
original-file or source-receipt permissions. Context and program grants do not confer
artist confirmation authority. Artists can invite documentation editors;
program coordinators assign reviewers. Artists cannot appoint institutional
reviewers and coordinators cannot assign themselves extra evidence access.

Program viewers can read the program queue, current drafts, confirmed history,
publication files, and Questions for the team. Their profile IDs or existing
group IDs are stored separately in `artwork_documentation_program_viewers`.
Group eligibility is evaluated using the site's current criteria for the
explicitly granted group IDs; membership is never copied into individual grants.
The dedicated eligibility reader uses the documentation write pool (and current
transaction when present), so a lagging read replica cannot retain removed access.
The list endpoint evaluates group eligibility once for that list request;
subsequent requests and mutation authorization evaluate the current state again.
These viewer rows deliberately provide all read capabilities, including legacy
archival files, rights evidence, source receipts, contact and restricted answers,
and no editing, artist
confirmation, review, assignment, or lifecycle authority. Existing artist,
context collaborator, reviewer, and coordinator grants retain their permissions.
The API does not return the viewer roster or group membership to readers.

Discussion writes require at least one existing writer capability:
`confirm_as_artist`, a nonempty `edit_modules` or `review_lanes` array,
`manage_context`, or `manage_assignments`. All mutations retain their narrower
operation-specific checks. A grant containing only read permissions cannot
create, reply to, or resolve questions. Program viewer access alone also does
not invite the viewer to create another program context for an existing work.

### Read and mutation projections

Context responses expose the combined read permissions in `capabilities` and
the original artist/collaborator permissions in the required
`mutation_capabilities` object. Program viewer reads never augment mutation
authority. Frontend write controls must use `mutation_capabilities`, retaining
the operation-specific field, asset, review and discussion checks.

The required `mutation_restricted_paths` array preserves historical restriction
gates for already visible fields and asset links. It omits paths whose answers
or referenced assets are redacted from the caller's read projection. A currently
public-looking value can therefore remain outside a collaborator's original
write scope. The array contains paths only, never hidden values.

Upload-session responses include the required `can_mutate` boolean, computed
from original write permissions and the stored session's ownership, reference
and lifecycle state. A readable upload does not imply permission to resume or
change it. Authorized recovery of an uploader's own unreferenced file remains
available; clients must require `can_mutate: true` for recovery controls.

Context list summaries include `owner_profile_id`, nullable
`artist_display_name` and `artist_preferred_credit`, and nullable
`source_submission`. Artist names come from the documented identity answers
and retain their current and historical restriction gates. The owner profile ID
identifies the already authorized record; it is not a substitute artist credit.

`source_submission` contains `drop_id`, `wave_id`, `source_receipt_id` and a
nullable original `title`. It is returned only with `read_source_receipts`
permission and a linked source, using one batched lookup for the authorized
records on the current page. The earliest receipt is selected by creation time
and then receipt ID. Excerpted, malformed, missing, non-string or over-255-codepoint
titles return null while the authorized source identifiers remain available.
The original title is separate from the documented artwork `title`; neither
replaces the other. No live Drop join or media lookup is performed.

### Publication-only intake

The latest version of each profile is version 2, with `intake_mode:
publication_only`. Profile IDs stay stable. Version 1 snapshots remain available
with their existing permissions; no legacy private answer is silently published
or deleted. Version 2 prepares one artwork record whose answers and selected
files are intended for eventual public publication. MySQL and private object
storage hold the draft workspace until the separate future publication/mint
process. There is no private appendix in the final artwork record.

Version 2 removes private contact, private source-file inventory, depicted-person
and consent-evidence fields, identifiability notes and sensitive-context notes.
It accepts no `restricted` visibility or `withheld` answer status. Public rights
declarations and institutional rights review remain; omitting private evidence
from intake does not establish consent or clearance. Uploads and attachments
reject camera originals, working files, consent instruments and rights
instruments. Other supporting materials must be intended for publication, and
interview assets require explicit public publication permission.

Artists use context-level `artist_and_reviewers`, `ordinary` threads without a
field or revision binding for **Questions for the team**. These are drafting
discussion outside the artwork record, not a hidden archival appendix. Relevant
resolved information belongs in the public artwork answers. Thread content is
never included in confirmation snapshots, asset manifests or public previews.

The server validates the pinned profile on answer writes, source imports,
artist-record pins, profile upgrades and confirmation. A shared artist revision
containing incompatible or restricted answers cannot be pinned into version 2;
the existing shared revision is preserved. Publication-only profiles cannot be
downgraded into private intake. Confirmation uses the profile's exact versioned
copy and still performs no publication, decentralization or mint transaction.

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

The dedicated `artworkDocumentationProcessor` also accepts closed actions
through IAM-authorized Lambda invocation. It has no HTTP operator endpoint. Keep
Lambda invoke access limited to release operators, with invocation audit logging
configured by the deployment owner. Applied actions record the supplied UUID correlation ID in the
documentation event table. No action changes process environment variables
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

```json
{"operator_action":"set_keys_and_gates_coordinator_read_access_v1","correlation_id":"<request-UUID>","coordinator_profile_id":"<verified-existing-coordinator-UUID>","apply":false}
```

This explicit read-access action is limited to `6529NM-AP-01` and requires an
existing profile with exactly one active program-wide grant already carrying
`read_context`, `manage_context` and `manage_assignments`. It never creates a
grant. After reviewing dry-run metadata, repeat with the same correlation UUID
and `apply: true` to enable only `read_archival_files`, `read_rights_evidence`,
`read_source_receipts`, `read_contact` and `read_restricted_fields`. All other
stored capabilities are preserved; editing, review lanes and artist confirmation
are not added. The transaction records an idempotent audit. Replays do not
reapply a revoked or subsequently narrowed grant. Output contains grant/program/
profile IDs, changed read flags, effective and target capabilities, context count
and the count of fields still redacted by the actual authorization/projection
service. No answers, filenames or asset hashes are returned.

`changed_read_flags` describes the original audited apply, including on replay;
it is not a statement of current authority. `effective_capabilities` and the
projection counts are fresh, best-effort reads after the transaction, rather
than cached apply results or one atomic snapshot. Concurrent permission changes
can therefore appear in these observations. Verify the actual effective read
flags and `redacted_field_count` before relying on the result; target capabilities
describe the proposed access only. A replay never restores subsequently removed
access, and a missing or revoked coordinator grant is rejected. A dry-run with a
previously used correlation remains a fresh read-only inspection.

```json
{"operator_action":"upgrade_empty_keys_and_gates_publication_v2","correlation_id":"<different-request-UUID>","coordinator_profile_id":"<verified-existing-coordinator-UUID>","apply":false}
```

The publication upgrade uses the same existing coordinator guard and hard-pinned
program. Dry-run lists eligible/skipped context IDs and reason codes. Explicit
apply upgrades only active version 1 Keys contexts with no answers, asset links,
restriction history, underlying asset/upload rows or confirmed revisions. Any
existing artist pin must be compatible. Sources, grants, threads and pins stay
unchanged. Eligible contexts advance one draft version with an audit event; the
correlation UUID makes retries idempotent. Concurrent upload reservation and
upgrade lock the context in the same order. A missing staging program grant is
an expected rejection, not a reason to relax these guards.

For this additive follow-up, deploy `artworkDocumentationProcessor` then `api`.
No table, storage-stack or migration deployment is required. Invoke the read
grant and publication upgrade only after both runtime units are verified in the
target environment. The existing public preview always retains its own
restricted projection even for a coordinator with full read access.

### Program viewer configuration

`set_program_viewers_v1` is a separate IAM-only operator. It accepts a known
documentation program, a verified existing program coordinator, and bounded
explicit profile/group IDs. It never changes original program/context grants,
artist ownership, answers, or confirmation authority. An empty viewer roster
revokes only entries managed by this operator.

```json
{
  "operator_action": "set_program_viewers_v1",
  "correlation_id": "<request-UUID>",
  "coordinator_profile_id": "<existing-coordinator-profile-UUID>",
  "program_id": "6529NM-AP-01",
  "viewers": {"profiles": ["<verified-profile-UUID>"], "groups": ["<verified-existing-group-ID>"]},
  "apply": false
}
```

Dry-run validates that the profiles/groups exist and inventories every original
program-wide grant (including its capabilities and revoked status) and every
managed viewer row. Review unexpected existing program-wide access separately;
the viewer operator deliberately preserves those grants and all context-level
collaborator access. The inventory contains no artist answers or filenames.

Apply the same request with `apply: true` and
`expected_inventory_sha256` set to the returned `inventory.inventory_sha256`.
The transaction locks the program grants and viewer rows, rejects changed
inventory, replaces only the viewer configuration, and records the result under
the correlation UUID. Its response includes before/after inventories and
effective capabilities for explicitly named profiles. The permanent audit
prevents an old request from restoring access after a later revocation, even
after the short-lived idempotency cache expires. A changed request using the
same correlation UUID is rejected. Apply replays return the original audited
response; perform a fresh dry-run and authenticated reads to verify current
state. A group removal takes effect when the existing group eligibility service
observes the changed criteria; no additional viewer membership cache is added.

For this viewer feature, deploy and invoke `dbMigrationsLoop` to create the
additive TypeORM viewer table, then deploy `artworkDocumentationProcessor` and
`api`. Existing storage is unchanged. Configure viewers only after the runtime
units are verified, starting with a dry-run. The API adds the context
`mutation_capabilities` and `mutation_restricted_paths` fields and upload-session
`can_mutate` field described above. Deploy these backend changes before the
paired frontend consumes the regenerated models and separates read and write
controls.

The later context-summary enrichment adds the identity and source fields
described above without a database or storage change. Once the viewer release
is deployed, this follow-up requires only `api` before its dependent frontend.

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
