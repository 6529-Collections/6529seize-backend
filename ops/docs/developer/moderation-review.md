# Developer moderation review

Watch Tower records moderation in the application database. Moderation decisions,
submitted text, report notes and model responses are never sent to Discord or an
operational webhook. Operational failures contain a safe diagnostic marker.

The policy families remain separate: REP categories, About text and group names
use the existing public-field prompts; posts use the existing permissive wave
policy, deterministic signals and confidence thresholds. This change adds review
and durable history, not a new image classifier or a tighter wave speech policy.

## Access and API

Every privileged endpoint requires the authenticated profile to occur in
`DEVS_6529_MENTION_PROFILE_IDS`, the exact `@devs6529` set. Proxies and broader
moderator roles do not grant access. Responses use `Cache-Control: private,
no-store`. Ordinary report, hide, block and report-withdrawal endpoints remain
available to users.

`GET /content-moderation/checks/access` returns the capability. `/checks` supports
subject, policy, outcome, trigger, review status, profile, subject ID, date and
cursor filters. `/checks/counts` returns summary counts; `/checks/{id}` returns
the preserved evidence, current state, original and later evaluations, action
history, evidence expiry and server-computed available actions. Historical
reports and profile suspension reviews can be opened with `/checks/report/{id}`
and `/checks/profile/{id}`.

Filter URLs contain identifiers and enums, never submitted text. A REP check's
public `subject_id` is its opaque check ID; category text is shown only in the
protected preview/evidence. Other subjects retain their profile, group or drop
identifier, including author/context identifiers for unpublished submissions.

`POST /checks/{id}/actions` requires an action, reason, expected item version and
UUID idempotency key. A changed version or conflicting key requires refreshing
the review. The previous unversioned drop-decision and profile-status POST
endpoints return `MODERATION_REVIEW_REQUIRED`; callers must use the review page.

## Decisions and resubmission

REP allow/block rules govern future use of the exact category until revoked.
They do not change existing ratings. The REP classifier cache records policy
and model provenance; legacy unversioned entries are reevaluated lazily.

Approving rejected About, group-name or post content issues a seven-day,
single-use permit. The author submits through the ordinary save endpoint with
an `Idempotency-Key` UUID. The permit matches author, exact content, operation,
relevant context and the preserved target revision. Its consumption and the save
commit together. A failed save rolls back consumption; an identical lost-response
retry returns the saved result. Approval itself never publishes archived content.
After consumption, only the original request-key replay succeeds; a new key
returns `MODERATION_PERMIT_CONSUMED`. Revoking the override returns later
attempts to ordinary classification and does not publish content.
Posting suspension, ordinary permissions, rate limits and unsafe-host blocks
remain authoritative.

Group permits match the group definition and replacement target, excluding
ephemeral draft IDs and creation timestamps. Included/excluded membership is
compared by profile IDs, not the freshly generated membership-container IDs.
The same approved definition can therefore be resubmitted after reloading the
editor. Changed criteria or a changed replacement target require fresh review.

Current About/group names can be suppressed and restored through a presentation
overlay bound to the preserved field revision. Stored source fields and group
membership are preserved. Published posts use the existing quarantine/removal
states. Re-evaluation always examines the preserved original snapshot, records a
new result using current policy/model configuration and does not revoke explicit
human decisions. The initial deterministic signal is preserved for later checks.

## Capture, privacy and retention

`content_moderation_items` stores the review scope, latest assessment, explicit
decision, permit and version. `content_moderation_evaluations` retains individual
attempts, cache hits, fallback outcomes and request provenance. The existing
moderation audit table retains actor/reason/action history; existing reports and
prepublication checks link to their review item. Ordinary posts without a signal
remain lightweight prepublication rows visible through the same listing.
Legacy reports materialize transactionally on first review, preserving their
original assessment policy, time, rationale and reporter notes. Concurrent opens
of one report share one imported evaluation; separate reports preserve separate
assessments. Submission history distinguishes the authenticated actor from a
profile they are acting for, without changing the author's approval scope.

Capture is committed before external classification and survives a rejected
content transaction. Capture failures stop the request; they cannot turn into an
allowed classifier fallback. Interrupted pending attempts become visible errors
after ten minutes. Model failures retain their existing behavior: single REP and
ambiguous prepublication checks may allow with an explicit failure marker;
About/group failures stop the save; reports remain for human review.

Wholly routine successful histories expire after 30 days. Reviewed evidence
expires 90 days after resolution; unresolved reports retain evidence while open.
Historical report expiry uses the actual latest report resolution time.
Compact action history is retained for one year. Active rules and suppression
retain authorizing scope/provenance for their lifetime and at least one year
after the last change. Expired evidence is displayed as unavailable and cannot
be reevaluated or used to approve an old submission. Old Discord-only history is
not imported by this change.

SQL diagnostics redact moderation statements, parameters and provider errors.
Evidence is private, inert data; clients must not render its HTML or load linked
media automatically.

## Rollout and verification

Deploy the additive entity schema through `dbMigrationsLoop` before API services
and the frontend. Preserve existing tables during rollback. The API and generated
frontend models come from the same OpenAPI source. The root Discord package can
be retired only after the separate operational-alert callers are removed too.

Tests cover policy/cache behavior, role/proxy denial, stale revisions, manual
decisions, permit consumption rollback/replay, JSON round trips, late model
results, retention and revision-specific public overlays. Database tests use an
isolated MySQL test container; they must not run against a shared application DB.

## Database baseline

An isolated MySQL 8.3 fixture on 2026-09-12 contained 20,000 routine checks,
2,000 detailed items and 4,000 evaluations. Evidence was 328 characters per
item; 10% of detailed items needed review. Each operation received three warmup
calls and 30 measured calls, sequentially, without provider requests or other
test suites running concurrently. These figures measure local database work,
not end-to-end requests or production latency.

| Operation                              | Median (ms) | p95 (ms) |
| -------------------------------------- | ----------: | -------: |
| Routine check insert                   |        1.62 |     2.91 |
| Detailed start and finish transactions |        9.23 |    15.74 |
| First page across both check sources   |       26.16 |    43.47 |
| Needs-review first page                |        2.58 |     2.93 |
| Author and public-field first page     |        8.94 |    13.24 |
| Counts                                 |        3.84 |     4.99 |
| Evaluation and action history          |        2.74 |     3.66 |

Before limiting each filtered source ahead of the final merge, the unfiltered
page measured 81.87 ms median and 100.86 ms p95 on the same fixture size. The
merged cursor still orders by creation time and ID; mixed-source tests cover
equal timestamps, page boundaries and subject filters.

After warmups and measurements, the tables held 20,033 routine checks, 2,033
items and 4,033 evaluations, using approximately 24 MiB of allocated table and
index pages. Allocation includes indexes and page overhead; it is not a
per-record storage forecast. A retention pass removed 1,000 routine detailed
items and their 2,000 evaluations in 208.75 ms. Deleting 1,000 expired lightweight
checks took 20.28 ms. Unresolved and active-rule fixtures remain protected by
the integration tests.

To repeat the procedure, use the repository's isolated testcontainer setup and
synthetic rows in the four moderation tables; never point it at an application
database. Measure monotonic elapsed time around `recordPrePublicationCheck`,
`start` plus `finish`, filtered `list`, `counts`, and `history`. Inspect allocated
bytes through `information_schema.tables` after `ANALYZE TABLE`. Mark exactly
1,000 routine successful items and 1,000 lightweight rows older than 30 days,
time `retain` and one `deleteExpiredPrePublicationChecks` batch, and verify the
remaining row counts. Repeat with realistic deployment volume and evidence
sizes before treating the local numbers as a production capacity or latency
budget.
