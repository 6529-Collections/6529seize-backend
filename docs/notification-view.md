# Notification view

Notifications are moving from rows each feature writes into `identity_notifications` to a view derived from source events: the chain's identity and wave records, the drop events on the relays, and people's signed records. The aim is a table that rebuilds from those sources and its archive to the same rows, with the same ids; what does not rebuild yet is listed under Archive and rebuild.

The pieces: the table, the per-cause switch, the deriver, the rules, the feed runner, the switch steps, the archive and the rebuild. The adapters that feed the rules from the chain and relay indexes land with those indexes; until then the rules and the runner are tested with fixtures of the source shapes in `src/notifications/view/notification-sources.ts`.

## Table

`notification_view` keeps every column the notification readers use, under the same names, so the existing queries run on it unchanged. Additions:

- `source_family`, `source_ref`, `source_key`: which rule wrote the row, from which source, and `sha256(family, ref, recipient)`. The primary key is `(identity_id, source_key)`.
- `id`: the id clients page and mark read by. A derived row's id is `created_at_ms * 4096 + the first 12 bits of source_key`: ordered by time, the same on every rebuild, above every `identity_notifications` id, and a safe JavaScript integer until 2039. Two rows of one person collide only in the same millisecond with the same 12 bits; the API then treats them as one id.
- `origin`: `DERIVED` for rule output; `CARRIED` for a copy of a row an old writer wrote for a cause not derived yet.
- `legacy_id`: the `identity_notifications` row written for this one while both tables live.
- `sealed`: a CARRIED row already written to the archive.

`notification_view_cursors` holds each feed's cursor and the switch's copy cursor. It is ephemeral: a lost cursor replays from the start, and a replay writes the same rows.

## Flags

All are read on every call from the process environment, which each service loads from its configuration when an instance starts. Set them the same for every service that writes or reads notifications (the API and the loops that notify), and redeploy those services to apply a change everywhere at once.

| Flag                    | Values                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_VIEW_MODE`      | `off` (default), `shadow`, `on` | `off`: today; nothing reads or writes the view. `shadow`: the deriver writes the view; readers, badges and pushes use `identity_notifications`. `on`: readers and badges use the view                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `NOTIFY_DERIVED_CAUSES` | `CAUSE@cutMs`, comma-separated  | From its cut a cause comes from the deriver and its old writers are skipped (one check in `identity-notifications.db.ts` covers every writer). Old writers compare the cut with the time they write, the deriver with the event's time, so each event is written once. Choose the cut no earlier than the moment the cause's old write path stopped being its source, and later than the deploy that sets it. An item without a valid cut is ignored, so its old writer keeps writing, and logged (`NOTIFY_DERIVED_CAUSES_IGNORED`). Ignored while the mode is `off`, so `off` always restores every old writer |
| `NOTIFY_LEGACY_OUTPUT`  | `true` (default), `false`       | The deriver also writes derived causes into `identity_notifications`, so that table stays complete in `shadow` and for a rollback from `on`. Turn it off only after the rebuild check passes                                                                                                                                                                                                                                                                                                                                                                                                                    |

## What the deriver does

A rule turns one source event into a group: every row for `(family, ref)`. The deriver, in one transaction per batch:

1. applies today's write filters (mutes, blocks, hidden drops, notification preferences) as they stand when the group is applied;
2. replaces the group's rows in the view: rows the new group lacks are deleted, changed rows are updated, and read state is kept;
3. for a derived cause, writes a copy into `identity_notifications` once per row (the view remembers its id), updates it when the row changes and deletes it, with a push cancellation, when the row goes. A new copy is pushed only for a live event less than 15 minutes old: a replay or a rebuild never pushes.

Applying the same group twice, with the same flags and filter state, changes nothing.

## Feeds and the runner

A feed reads one index's events after a cursor and names the rule for each (`NotificationFeed`). `NotificationFeedRunner` reads a batch, derives it, and commits the rows and the cursor after them in one transaction, so a crash repeats at most one batch and repeating it writes the same rows. It does nothing while the mode is `off`, so no cursor moves then. A run is `live`, or `replay` for a rebuild; a replay never pushes.

## Mode `on`

- `/notifications` reads, unread counts and badges read the view.
- The deriver writes view rows only for the causes it owns, from their cut; the CARRIED copies stand for the rest.
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

## The switch

Rows created before the switch keep their `identity_notifications` ids, so clients that remember an id (the desktop app's last-seen id, a push in the tray) see nothing change. The operator steps are in `ops/scripts/notification-view/cli.ts` (`bin/6529 exec ts-node -r tsconfig-paths/register ops/scripts/notification-view/cli.ts <step>`), each resumable and safe to run again:

1. Deploy `dbMigrationsLoop` (creates the tables), then every service with the flags unset. Nothing changes.
2. `NOTIFY_VIEW_MODE=shadow`, with the deriver running. A cause whose source has taken over joins `NOTIFY_DERIVED_CAUSES` with its cut (see Flags). Compare the view with `identity_notifications`.
3. At the switch, move every cut earlier than the switch time up to it. Rows before it stand as their old copies, with their old ids.
4. After the cut: `copy-old-rows`. It first deletes the rows the deriver wrote but does not own (causes not derived, or events before their cut), then copies every `identity_notifications` row the view lacks as CARRIED, with its id and read state.
5. `NOTIFY_VIEW_MODE=on`, then `copy-old-rows` again for the rows written in between.
6. `record-cuts` and `seal`, and `seal` again whenever old writers have added CARRIED rows (until every cause is derived).

A cause that joins later gets its own cut when it is added to `NOTIFY_DERIVED_CAUSES`; in `on` mode nothing needs pruning.

Not ready in this change, so the mode stays at `shadow`: pushes still carry `identity_notifications` ids, which a row an old writer adds in `on` mode does not keep, and read marks made during `shadow` do not reach the deriver's rows in the view.

## Archive and rebuild

What the view cannot derive goes into the private record log (`src/signed-records/record-log`), sealed to 6529.io's provider keys, under the lane `notify`:

- `notify-archive`: CARRIED rows, up to 1,000 per entry, with their ids and read state when sealed;
- `notify-cuts`: the cuts in force;
- `notify-read`: each read mark made in `on` mode through the routes (one row by its view id, all, or a wave), written in the same transaction as the mark.

`NotificationViewRebuild` rebuilds the view from empty with the production flags and `NOTIFY_LEGACY_OUTPUT=false`: it restores the archived rows, refuses a log whose cuts differ from the flags, replays every feed from the start, and applies the read marks in the order they were made. A mark-all or mark-wave reads every row that existed at its time.

What does not rebuild yet:

- The write filters read their current state whenever a group is applied, so a mute added after an event removes its row the next time the group is applied, and a rebuild applies today's mutes to old events.
- Deleting or editing a drop deletes the view rows of other drops that name it (replies and quotes, as `related_drop_2_id`), as it does in `identity_notifications`. The drop rule does not model this, so a rebuild brings those rows back.
- Read marks made in `shadow` are not logged.

## Rollback

`on` → `shadow` moves readers back to `identity_notifications`, which the deriver and the read marks kept current while `NOTIFY_LEGACY_OUTPUT` is on. `shadow` → `off` stops the deriver and restores every old writer.
