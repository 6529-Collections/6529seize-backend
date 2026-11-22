# Notification view

Notifications are moving from rows each feature writes into `identity_notifications` to a view derived from source events: the chain's identity and wave records, the drop events on the relays, and people's signed records. A table rebuilt from those sources gives the same rows, with the same ids.

This change adds the table, the per-cause switch, the deriver and the rules. The adapters that feed the rules from the chain and relay indexes land with those indexes; until then the rules are tested with fixtures of the source shapes in `src/notifications/view/notification-sources.ts`.

## Table

`notification_view` keeps every column the notification readers use, under the same names, so the existing queries run on it unchanged. Additions:

- `source_family`, `source_ref`, `source_key`: which rule wrote the row, from which source, and `sha256(family, ref, recipient)`. The primary key is `(identity_id, source_key)`.
- `id`: the id clients page and mark read by. A derived row's id is `created_at_ms * 4096 + the first 12 bits of source_key`: ordered by time, the same on every rebuild, above every `identity_notifications` id, and a safe JavaScript integer until 2039. Two rows of one person collide only in the same millisecond with the same 12 bits; the API then treats them as one id.
- `origin`: `DERIVED` for rule output; `CARRIED` for a copy of a row an old writer wrote for a cause not derived yet.
- `legacy_id`: the `identity_notifications` row written for this one while both tables live.

## Flags

All are read on every call from the process environment, which each service loads from its configuration when an instance starts. Set them the same for every service that writes or reads notifications (the API and the loops that notify), and redeploy those services to apply a change everywhere at once.

| Flag                    | Values                          | Effect                                                                                                                                                                                                   |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_VIEW_MODE`      | `off` (default), `shadow`, `on` | `off`: today; nothing reads or writes the view. `shadow`: the deriver writes the view; readers, badges and pushes use `identity_notifications`. `on`: readers and badges use the view                    |
| `NOTIFY_DERIVED_CAUSES` | comma-separated causes          | Causes the deriver produces. Their old writers are skipped (one check in `identity-notifications.db.ts` covers every writer). Ignored while the mode is `off`, so `off` always restores every old writer |
| `NOTIFY_LEGACY_OUTPUT`  | `true` (default), `false`       | The deriver also writes derived causes into `identity_notifications`, so that table stays complete in `shadow` and for a rollback from `on`. Turn it off only after the rebuild check passes             |

## What the deriver does

A rule turns one source event into a group: every row for `(family, ref)`. The deriver, in one transaction per batch:

1. applies today's write filters (mutes, blocks, hidden drops, notification preferences), so a derived row exists exactly when the old writer would have written it;
2. replaces the group's rows in the view: rows the new group lacks are deleted, changed rows are updated, and read state is kept;
3. for a derived cause, writes a copy into `identity_notifications` once per row (the view remembers its id), updates it when the row changes and deletes it, with a push cancellation, when the row goes. A new copy is pushed only for a live event less than 15 minutes old: a replay or a rebuild never pushes.

Applying the same group twice changes nothing.

## Mode `on`

- `/notifications` reads, unread counts and badges read the view.
- Mark-read by id accepts the view id or the `identity_notifications` id a client got earlier, for example from a push. Mark-read, mark-all-read and mark-wave-read also update `identity_notifications` while `NOTIFY_LEGACY_OUTPUT` is on.
- A row an old writer adds for a cause not derived yet is copied into the view as `CARRIED`, with a time-ordered id.
- Pushes still come from `identity_notifications` rows; push and WebSocket delivery from the view come in a later change.

Deleting a drop or a wave, a wave's visibility change and a profile merge update the view as they update `identity_notifications`, in every mode but `off`.

## Rules

| Rule                      | Causes                                                   | Source                                                                                                                        |
| ------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `deriveRating`            | IDENTITY_REP, IDENTITY_NIC                               | Applied rating changes (operations only)                                                                                      |
| `deriveVote`              | DROP_VOTED                                               | Vote changes, including scan cuts                                                                                             |
| `derivePollBallot`        | DROP_POLL_VOTED                                          | Poll ballots                                                                                                                  |
| `deriveWaveCreated`       | WAVE_CREATED                                             | Wave creation                                                                                                                 |
| `deriveDecisionResult`    | COMPETITION_LIFECYCLE                                    | Final decided results with a winner                                                                                           |
| `deriveEntryReleased`     | VOTING_CREDITS_RETURNED                                  | Entries leaving ACTIVE as winner or withdrawn by their submitter                                                              |
| `deriveSubmissionCreated` | ARTIST_ARTWORK_SUBMITTED                                 | Submissions to a decision in `MAIN_STAGE_DECISION_IDS`                                                                        |
| `deriveReaction`          | DROP_REACTED, DROP_BOOSTED                               | Reaction events; `boost` is the boost reaction                                                                                |
| `deriveDropCreation`      | DROP_REPLIED, DROP_QUOTED, IDENTITY_MENTIONED, ALL_DROPS | A drop's visible versions; the latest decides who and why, a row keeps the time of the first version that named its recipient |
| `derivePriorityAlert`     | PRIORITY_ALERT                                           | Alert drops                                                                                                                   |
| `deriveFollow`            | IDENTITY_SUBSCRIBED                                      | Follow records                                                                                                                |

MEME_COLLABORATION, SUBSCRIPTION_COVERAGE and E2EE_MESSAGE keep their writers until their own records exist.

## Deploy and rollback

1. Deploy `dbMigrationsLoop` (creates `notification_view`), then every service with the flags unset. Nothing changes.
2. `NOTIFY_VIEW_MODE=shadow` once the deriver has a source; compare the view with `identity_notifications`.
3. Add causes to `NOTIFY_DERIVED_CAUSES` as their sources take over.
4. `NOTIFY_VIEW_MODE=on` to switch readers.

Rollback: `on` → `shadow` moves readers back to `identity_notifications`, which the deriver and the read marks kept current. `shadow` → `off` stops the deriver and restores every old writer.
