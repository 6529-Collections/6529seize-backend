# Content moderation

## Purpose and policy

Content moderation combines four separate controls:

1. a permissive pre-publication safety gate for new and edited drops;
2. private viewer controls for hiding drops and blocking profiles;
3. reporting plus AI-assisted prioritization for occasional moderators; and
4. global moderator decisions and posting suspension.

The system is intentionally narrow. It is not a profanity filter and it does
not reject content merely because it is offensive, controversial, or
unpopular. Automated decisions use high-confidence thresholds, and ambiguous
classifier results fail open.

This document is the backend source of truth for the feature's policy,
lifecycle, persistence, and service boundaries. The frontend's user-facing
behavior is documented in the related frontend feature guide.

## Pre-publication flow

Every authenticated create or update of user-authored drop content is prepared
before the drop-write transaction begins:

1. Sanitize the candidate drop and resolve its author, operation, and drop ID.
2. Reject immediately if the author profile is suspended from posting.
3. Build normalized text from the title and textual parts, then calculate a
   SHA-256 content fingerprint.
4. Run the deterministic screen.
5. Allow immediately when there is no signal.
6. Reject a configured known-unsafe destination directly.
7. Send other narrow signals to the dedicated Bedrock evaluator.
8. Reject only when the evaluator returns `REJECT` with confidence of at least
   `0.95`; otherwise allow.
9. Record the decision, then pass a preparation token into the transactional
   drop write.
10. Recalculate and compare the operation, drop ID, author, and fingerprint
    inside the write path so the approved content cannot be replaced before it
    is persisted.

The gate returns HTTP `422` with code `CONTENT_MODERATION_REJECTED` for a
content rejection. A suspended profile receives HTTP `403` before the
deterministic or AI checks run.

### Deterministic screen

| Check | Result |
| --- | --- |
| Empty textual content | Allow without AI. |
| Host matches `CONTENT_MODERATION_BLOCKED_HOSTS` exactly or as a subdomain | Reject directly without AI. |
| Same author and normalized fingerprint has appeared at least four times in the preceding ten minutes | Send `REPEATED_IDENTICAL_CONTENT` to AI. |
| US Social Security number pattern or a 13-19 digit Luhn-valid payment-card candidate | Send `STRUCTURED_SENSITIVE_DATA` to AI. |
| Narrow first-person threat pattern | Send `EXPLICIT_THREAT_PATTERN` to AI. |
| Minor/underage term near a sexual-exploitation term | Send `SEXUAL_EXPLOITATION_PATTERN` to AI. |
| No configured signal | Allow without AI. |

Profanity is not a deterministic signal. The repeated-content rule is a signal
for contextual evaluation, not a direct spam rejection.

### AI result and failure handling

The pre-publication evaluator receives only content that produced a narrow
deterministic signal. It is instructed to be permissive and returns `ALLOW` or
`REJECT`, a constrained category, confidence, and rationale.

For `STRUCTURED_SENSITIVE_DATA`, genuine usable private identifiers are
rejected whether they belong to the author or another person. Clearly labelled
fictitious, sandbox, test, example, redacted, or documentation data is allowed;
an ownership claim or a value's known test status is not decisive by itself.

- `REJECT` at confidence `>= 0.95` rejects the request.
- `ALLOW`, a lower-confidence result, or an uncertain result allows it.
- A timeout, model error, or malformed response is recorded as an evaluator
  error and allows the request.

The model's category or rationale is not reflected directly into the generic
user-facing rejection response.

### Attachments

The synchronous gate reads only the title and textual drop parts. File and
media contents, including PDF and CSV uploads, remain in the existing
asynchronous attachment and media-sanitization pipelines. Their verdicts and
hash metadata may be included in a later report snapshot, but they are not
treated as synchronously cleared by the text gate.

## Personal viewer controls

Personal controls are authenticated, viewer-scoped state:

- `PUT` or `DELETE /content-moderation/drops/{drop_id}/hide` hides or unhides
  one drop for the current profile.
- `PUT` or `DELETE /content-moderation/profiles/{profile_id}/block` blocks or
  unblocks one profile for the current profile.
- `GET /content-moderation/blocked-profiles` returns the current profile's
  blocked profiles.

Hiding does not change the drop's global state. Blocking changes only the
viewer's presentation of the blocked profile's drops. Personal hide and block
state is returned in viewer-specific drop presentation data and is used to
suppress related notifications for that viewer.

## Reporting

`POST /content-moderation/drops/{drop_id}/reports` creates a report. Reporting,
hiding the drop, and blocking the author are independent choices in one
request. A user cannot report their own drop.

Before calling the reported-content evaluator, the backend commits one
transaction containing:

- the report and its reason or optional notes;
- a private evidence snapshot of the drop and available parent context; and
- any requested personal hide or block actions.

Duplicate open reports by the same reporter and drop are rejected. Report
volume is limited per profile by `CONTENT_MODERATION_REPORTS_PER_HOUR`, which
defaults to `100`.

### Report assessment

The reported-content evaluator returns one of:

- `NO_VIOLATION_DETECTED`;
- `NEEDS_HUMAN_REVIEW`; or
- `URGENT_QUARANTINE`.

Only `URGENT_QUARANTINE` with confidence of at least `0.95` can temporarily
move an open report's drop to `AI_QUARANTINED`. Other outcomes stay visible and
remain available to the occasional moderator queue. If assessment fails, the
report is retained with `NEEDS_HUMAN_REVIEW`, zero confidence, and an explicit
classifier-unavailable rationale.

AI never removes content permanently and never suspends a profile.

## Moderator workflow

Moderator access is server-enforced. It comes from explicit profile IDs in
`CONTENT_MODERATOR_PROFILE_IDS` or an existing durable role row; checking
access does not create a role. The route `GET
/content-moderation/moderator-access` exposes the current authenticated
profile's access state.

Authorized moderators use:

- `GET /content-moderation/reports` for the prioritized, cursor-paginated open
  queue;
- `POST /content-moderation/drops/{drop_id}/decision` to allow/restore,
  quarantine, or remove a drop; and
- `POST /content-moderation/profiles/{profile_id}/status` to suspend or
  reinstate posting for a profile.

Every drop or profile decision requires a written reason. Drop decisions are
applied transactionally with report resolution and append-only audit history,
so a late AI response cannot overwrite a human decision. Quarantine keeps a
report open; allow and remove resolve it.

There is no continuous hold-before-publish queue. Moderators address reported
content occasionally, with urgent high-confidence AI quarantine providing a
temporary safety measure until then.

## Posting suspension

Posting suspension is a manual moderator state, not an account ban.

- `ACTIVE` is the default when no profile-state row exists.
- `SUSPENDED` blocks new and edited user-authored drop content before the
  deterministic and AI checks run.
- The state has no automatic expiry. A moderator must explicitly set the
  profile back to `ACTIVE`.
- A moderator cannot change their own moderation status.
- The target profile must exist, and the decision, moderator, reason, previous
  state, new state, and time are audited.

Suspension does not delete or globally hide existing drops. It does not by
itself prevent authentication, reading, or management of personal visibility
preferences. Because chat messages, replies, and direct messages are persisted
as drops, the same create/update gate applies to those publishing paths.

## Presentation and distribution

Global drop states are:

- `VISIBLE`;
- `AI_QUARANTINED`; and
- `MODERATOR_REMOVED`.

Global state takes precedence over personal block or hide state. For globally
unavailable content:

- the author retains access to their own content and moderation state;
- other viewers receive redacted content while structural graph metadata is
  preserved; and
- ordinary viewers cannot locally reveal the redacted content.

The same presentation calculation is applied across V1, V2, light-drop,
reply, quote, leaderboard, and WebSocket surfaces. Notification writes, reads,
badge counts, and push delivery suppress blocked authors and globally
unavailable drops for recipients who cannot view them.

Moderation state changes are broadcast as best-effort WebSocket updates.
Clients also refresh presentation data after local actions and moderator
decisions, so a missed broadcast converges on the next API read.

## Persistence, retention, and audit

MySQL stores:

- profile blocks;
- hidden drops;
- reports and private evidence snapshots;
- global drop states;
- profile posting states;
- moderator roles;
- pre-publication decisions; and
- append-only moderation audit records.

Pre-publication decision records are retained for 30 days and pruned daily by
`dbMigrationsLoop` in bounded batches of 1,000 rows, with at most ten batches
per invocation. The retention period is deliberately longer than the ten-minute
duplicate-signal window.

## Runtime ownership and rollout

No new service is introduced. The affected services are:

- `api`: moderation endpoints, pre-publication checks, presentation, reports,
  moderator actions, and WebSocket changes;
- `pushNotificationsHandler`: recipient-specific push filtering and
  invalidation; and
- `dbMigrationsLoop`: additive table synchronization and daily retention
  cleanup.

For an initial environment rollout, deploy `dbMigrationsLoop` first, then
`api`, then `pushNotificationsHandler`, and deploy the compatible frontend
after the backend API is available.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CONTENT_MODERATOR_PROFILE_IDS` | Comma-separated bootstrap moderator profile IDs. Empty grants no configured access. |
| `CONTENT_MODERATION_BLOCKED_HOSTS` | Comma-separated exact or parent hosts for deterministic unsafe-destination rejection. Empty disables this direct-rejection list. |
| `CONTENT_MODERATION_BEDROCK_MODEL_ID` | Optional moderation-specific Bedrock model; otherwise the existing configured/default Anthropic model is used. |
| `CONTENT_MODERATION_REPORTS_PER_HOUR` | Per-profile report ceiling; defaults to `100`. |

## Related documentation

- [Architecture overview](architecture.md)
- [Backend PR report](../pr-reports/1937.md)
- [Frontend content moderation guide](https://github.com/6529-Collections/6529seize-frontend/blob/main/ops/docs/content-moderation.md)
- [Frontend PR](https://github.com/6529-Collections/6529seize-frontend/pull/3791)
