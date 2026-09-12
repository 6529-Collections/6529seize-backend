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

| Check                                                                                                | Result                                    |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Empty textual content                                                                                | Allow without AI.                         |
| Host matches `CONTENT_MODERATION_BLOCKED_HOSTS` exactly or as a subdomain                            | Reject directly without AI.               |
| Same author and normalized fingerprint has appeared at least four times in the preceding ten minutes | Send `REPEATED_IDENTICAL_CONTENT` to AI.  |
| US Social Security number pattern or a 13-19 digit Luhn-valid payment-card candidate                 | Send `STRUCTURED_SENSITIVE_DATA` to AI.   |
| Narrow first-person threat pattern                                                                   | Send `EXPLICIT_THREAT_PATTERN` to AI.     |
| Minor/underage term near a sexual-exploitation term                                                  | Send `SEXUAL_EXPLOITATION_PATTERN` to AI. |
| No configured signal                                                                                 | Allow without AI.                         |

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
user-facing rejection response. The parser also enforces semantic consistency:
`ALLOW` must use category `NONE`, while `REJECT` must use a substantive policy
category. A contradictory response is treated as malformed and follows the
normal fail-open path.

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

Blocking also removes the blocker's existing identity subscriptions to that
profile in the same transaction. A blocker cannot subscribe to the profile
again until they unblock it. The reverse relationship is not changed: blocking
does not remove the blocked profile's subscriptions to the blocker, expose the
block to that profile, or make either public profile unavailable.

Blocking acts as a directional, privacy-preserving mute. One-to-one direct
messages remain available under the normal direct-message admission policy,
including conversations created after the block. For the blocker, the
conversation is effectively muted and deprioritized without changing any saved
manual mute setting. Messages from the blocked profile are retained but use the
normal personal-block presentation until individually revealed. The blocked
profile receives no delivery error or explicit block disclosure.

Group direct messages and shared Waves also remain usable. Drops from a profile
the viewer blocked retain the normal personal-block presentation, and that
profile's activity does not create ordinary notifications, push notifications,
or unread counts for the blocker. Activity from other group members continues
to behave normally.

## Reporting

`POST /content-moderation/drops/{drop_id}/reports` creates a report and always
hides that drop for the reporter in the same transaction. Blocking the author
remains optional, and a user can still hide or block without reporting. A user
cannot report their own drop.

Before calling the reported-content evaluator, the backend commits one
transaction containing:

- the report and its reason or optional notes;
- a private evidence snapshot of the drop and available parent context; and
- the reporter's personal hide and any requested profile block.

Duplicate non-withdrawn reports by the same reporter and drop are rejected.
Other profiles may still report the same drop independently. Report volume is
limited per profile by `CONTENT_MODERATION_REPORTS_PER_HOUR`, which defaults to
`100`.

`GET /content-moderation/reports/mine` returns a stable cursor-paginated list of
the authenticated profile's own reports for the Preferences Reports view. It
includes author identity, the submitted reason and notes, report state, public
outcome, global drop state, current wave name and picture, and a reporter-safe
snapshot of the reported post. The snapshot lets the reporter recognize
content after moderators remove it, while the wave metadata preserves its
origin and supports navigation for existing reports. It excludes reply-parent
context, upload and attachment identifiers, hashes, scanner verdicts, and other
evidence-only metadata. The endpoint is strictly scoped to the caller and does
not expose AI assessments, internal moderator notes or reasons, moderator
identity, the full private evidence snapshot, or reports submitted by other
profiles.

The latest non-withdrawn report status is returned in authenticated viewer
presentation data. While their report remains open, the reporter may withdraw
it with `DELETE /content-moderation/drops/{drop_id}/reports/mine`. Withdrawal
is an audited status transition rather than deletion, leaves the personal hide
unchanged, and has no effect on reports from other profiles. If the withdrawn
report was the only open report and its AI assessment alone caused an urgent
quarantine, the drop returns to `VISIBLE`; a human moderator quarantine is
never undone by withdrawal. Resolved reports cannot be withdrawn or reported
again by the same profile. A profile may submit a new report only after
withdrawing its earlier open report.

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
The parser requires `NO_VIOLATION_DETECTED` to use category `NONE`, and requires
human-review or urgent-quarantine recommendations to use a substantive policy
category. Contradictory evaluator output is treated as an assessment failure,
so the report remains available for human review.

## Moderator workflow

Moderator access is server-enforced. It comes from the union of profile IDs in
`DEVS_6529_MENTION_PROFILE_IDS`, additional profile IDs in
`CONTENT_MODERATOR_PROFILE_IDS`, and existing durable role rows; checking
access does not create a role. The route `GET
/content-moderation/moderator-access` exposes the current authenticated
profile's access state and whether the WatchTower queue has open reports.

Authorized moderators use:

- `GET /content-moderation/reports?view=OPEN` for the prioritized,
  cursor-paginated open queue, including the reporting profile's handle and
  profile picture alongside the author identity;
- `GET /content-moderation/reports?view=RESOLVED` for resolved report history;
- `GET /content-moderation/block-activity` for the newest-first,
  cursor-paginated history of real profile-block transitions;
- `GET /content-moderation/profiles/suspended` for the current suspended
  profile list;
- `POST /content-moderation/drops/{drop_id}/decision` to allow/restore,
  quarantine, or remove a drop; and
- `POST /content-moderation/profiles/{profile_id}/status` to suspend or
  reinstate posting for a profile.

The profile-status endpoint is also used by the moderator-only action on a
public profile page. That global moderation state is independent of the
moderator's own personal block state.

Moderator notes are optional for both drop and profile actions. Drop decisions
are applied transactionally with report resolution and append-only audit
history, so a late AI response cannot overwrite a human decision. Allow keeps
or restores the drop to visible and resolves open reports as allowed;
quarantine hides the drop globally but keeps reports open; remove hides it
globally and resolves open reports as removed. Profile suspension is presented
as a separate action because it controls future publishing rather than the
reported post.

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
- The target profile must exist. The decision, moderator, optional note,
  previous state, new state, and time are audited.

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

The moderator-only block-activity history is built from transition audit
records. Each item identifies its `PROFILE_BLOCKED` or `PROFILE_UNBLOCKED`
action. Request `include_unblocks=true` to combine both actions in one
newest-first cursor feed; omission retains block-only results for older clients
that cannot render unblocks. Pagination uses the timestamp and audit ID across
both actions, and an unblock never removes earlier history. Fetch the next page
using the last item's cursor; a page shorter than the requested limit ends the
feed. A full final page requires one additional request that returns an empty
array.

Repeating a block or unblock request without changing relationship
state does not add another audit event, while blocking again after an unblock
creates a new event. The history remains independent from content reports and
does not invoke automated moderation or change global content/profile state.

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

| Variable                              | Purpose                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DEVS_6529_MENTION_PROFILE_IDS`       | Comma-separated `@devs6529` profile IDs. These profiles are also content moderators.                                             |
| `CONTENT_MODERATOR_PROFILE_IDS`       | Comma-separated additional moderator profile IDs, combined with `DEVS_6529_MENTION_PROFILE_IDS`.                                 |
| `CONTENT_MODERATION_BLOCKED_HOSTS`    | Comma-separated exact or parent hosts for deterministic unsafe-destination rejection. Empty disables this direct-rejection list. |
| `CONTENT_MODERATION_BEDROCK_MODEL_ID` | Optional moderation-specific Bedrock model; otherwise the existing configured/default Anthropic model is used.                   |
| `CONTENT_MODERATION_REPORTS_PER_HOUR` | Per-profile report ceiling; defaults to `100`.                                                                                   |

## Related documentation

- [Architecture overview](architecture.md)
- [Backend PR report](../pr-reports/1937.md)
- [Frontend content moderation guide](https://github.com/6529-Collections/6529seize-frontend/blob/main/ops/docs/content-moderation.md)
- [Frontend PR](https://github.com/6529-Collections/6529seize-frontend/pull/3791)
