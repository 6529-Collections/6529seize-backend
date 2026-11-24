# Notification view

Notifications are moving from rows each feature writes into `identity_notifications` to a view derived from source events: the chain's identity and wave records, the drop events on the relays, and people's signed records. Rebuilt from those sources and its archive, the table gives the same answers, ids and read state included, for the causes whose feeds run; what a rebuild relies on, and how to run it, is under Archive and rebuild.

The pieces: the table, the per-cause switch, the deriver, the rules, the feed runner, the switch steps, the archive and the rebuild. The adapters that feed the rules from the chain and relay indexes land with those indexes; until then the rules and the runner are tested with fixtures of the source shapes in `src/notifications/view/notification-sources.ts`.

## Table

`notification_view` keeps every column the notification readers use, under the same names, so the existing queries run on it unchanged. Additions:

- `source_family`, `source_ref`, `source_key`: which rule wrote the row, from which source, and `sha256(family, ref, recipient)`. The primary key is `(identity_id, source_key)`.
- `id`: the id clients page and mark read by. A derived row's id is `created_at_ms * 4096 + the first 12 bits of source_key`: ordered by time, the same on every rebuild, above every `identity_notifications` id, and a safe JavaScript integer until 2039. Two rows of one person collide only in the same millisecond with the same 12 bits; the API then treats them as one id.
- `origin`: `DERIVED` for rule output; `CARRIED` for a copy of a row an old writer wrote for a cause not derived yet.
- `legacy_id`: the `identity_notifications` row written for this one while both tables live.
- `sealed`: a CARRIED row already written to the archive.

`notification_view_cursors` holds each feed's cursor and the switch's copy cursor. It is ephemeral: a lost cursor replays from the start, and a replay writes the same rows.

`notification_view_push_outbox` queues pushes of view rows by `(identity_id, source_key)` (see Pushes and frames). It is ephemeral like `push_notification_outbox_entries`.

## Flags

All are read on every call from the process environment, which each service loads from its configuration when an instance starts. Set them the same for every service that writes or reads notifications (the API and the loops that notify), and redeploy those services to apply a change everywhere at once.

| Flag                    | Values                                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_VIEW_MODE`      | `off` (default), `shadow`, `on`                                            | `off`: today; nothing reads or writes the view. `shadow`: the deriver writes the view; readers, badges and pushes use `identity_notifications`. `on`: readers, badges, pushes and notification frames use the view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NOTIFY_DERIVED_CAUSES` | windows, comma-separated: `CAUSE@startMs` (open) or `CAUSE@startMs..endMs` | Within a window a cause comes from the deriver and its old writers are skipped (one check in `identity-notifications.db.ts` covers every writer); outside every window its old writers write it. Old writers compare the windows with the time they write, the deriver with the event's time, so each event is written once. A start or an end must be later than the deploy that sets it, and a start no earlier than the moment the cause's old write path stopped being its source. A cause's windows only grow (see Handing a cause back). An item with a malformed window, or one overlapping an earlier window of its cause, is ignored and logged (`NOTIFY_DERIVED_CAUSES_IGNORED`); a cause's latest start or end earlier than an instance's start is logged as a warning (`NOTIFY_DERIVED_CAUSE_CUT_BEFORE_START`). Ignored while the mode is `off`, so `off` always restores every old writer |
| `NOTIFY_LEGACY_OUTPUT`  | `true` (default), `false`                                                  | The deriver also writes derived causes into `identity_notifications`, so that table stays complete in `shadow` and for a rollback from `on`. Turn it off only after the rebuild check passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## What the deriver does

A rule turns one source event into a group: every row for `(family, ref)`. The deriver, in one transaction per batch:

1. keeps every row the rule derives, except rows that name a deleted drop (`deleted_drops`). Mutes, blocks, moderation and notification preferences are not applied here: they apply when the view is read, so the rows never depend on their state now;
2. replaces the group's rows in the view: rows the new group lacks are deleted, changed rows are updated, and read state is kept;
3. for a derived cause, writes a copy into `identity_notifications` when a row first appears and today's write filters (mutes, blocks, hidden drops, preferences) let it through, as the old writer would; the view remembers the copy's id, updates it when the row changes and deletes it, with a push cancellation, when the row goes. A row the view held before its cause was derived gets no copy: the old writer's row stands;
4. queues a push for a new row of a live event less than 15 minutes old (30 for ratings, see the ratings feed) that the write filters let through: the copy's id in `shadow`, the view row in `on`.

Applying the same group twice changes nothing, whatever the filters' state. A replay (a rebuild) writes only the view: no copies and no pushes.

Deleting a drop or a wave removes every row that names it from both tables, as before. Editing a drop leaves the deriver's rows and their copies alone, since the rule re-derives them from the edit and keeps their read state; rows of causes not derived yet go and come back from their old writer, as before.

## Feeds and the runner

A feed reads one index's events after a cursor and names the rule for each (`NotificationFeed`). `NotificationFeedRunner` reads a batch, derives it, and commits the rows and the cursor after them in one transaction, so a crash repeats at most one batch and repeating it writes the same rows. Runners of one feed take turns on its cursor row; a batch whose transaction deadlocks is tried again, up to three times. It does nothing while the mode is `off`, so no cursor moves then. A run is `live`, or `replay` for a rebuild; a replay never pushes.

Every source event carries its origin. What was copied in from 6529.io or read again from history (`IMPORT`) notifies nobody, since 6529.io notified it when it happened, and neither does a chain change whose writer the index can't name (`UNKNOWN`). The chain's own work (`SCAN`: a cap's cut, a decision falling due) notifies only where today's code does. A drop version that an import wrote names nobody new; an edit made later notifies only the recipients it adds.

`runNotificationFeedsSafely` (`notification-feeds.ts`) runs the production feeds, live, in a database context of their own. `delegationsLoop` calls it at the end of every run, a failed one too, so every minute and right after the identity mirror. A failure of the feeds is logged (`NOTIFY_FEEDS_FAILED`, or `NOTIFY_FEED_FAILED` for one feed) and reported, never thrown, so the loop's own result stands. A feed runs only while one of its causes has a window, and each run gets a minute of batches. The feeds wait for the loop's own work, so a long `delegationsLoop` run (a reconsolidation) delays them: a row derived past its feed's push window (15 minutes after its event, 30 for ratings) is listed but not pushed. `CAUSES_WITH_FEEDS` lists the causes the production feeds write.

`identity:ratings` (`feeds/identity-ratings-feed.ts`) reads `identity_chain_rating_events`, the identity mirror's log of the rating changes it applied from the chain's feed. It reads in id order, the order the mirror wrote, from rows at least 10 seconds old, so a row the mirror writes later at a lower height is still read. Only a rater's own change (`OPERATION`, not by the import) notifies, as today; the read skips the rest in the database, a range of ids per batch. A change is named by the mirror's key, (height, rater principal, target principal, matter, category), so a profile merge renames nothing. The cursor is the last row looked at, (height, id), and the changes whose rater or target the mirror has not mapped to a profile yet (a principal made on the chain, usually mapped within a minute): each read reads those again and they notify once mapped, while the rows after them go on. A change still unmapped 15 minutes after its write, or beyond the 32 newest waiting, is dropped unnotified (`IDENTITY_RATINGS_UNSETTLED_SKIPPED`). If the cursor's row is gone or moved because the mirror's table was rebuilt, the feed reads the table again from the start, and the rows read twice change nothing.

## Mode `on`

- `/notifications` reads, unread counts and badges read the view. Mutes, blocks, moderation and notification preferences hide rows when they are read, so unmuting someone, or switching a kind of notification back on, shows rows that arrived meanwhile.
- The deriver writes view rows only for the causes it owns, from their cut; the CARRIED copies stand for the rest.
- Mark-read by id accepts the view id or the `identity_notifications` id a client got earlier, for example from a push. Mark-read, mark-all-read and mark-wave-read also update `identity_notifications` while `NOTIFY_LEGACY_OUTPUT` is on. In `shadow` they update the view too, so the deriver's rows keep their read state at the switch; both modes log them (see Archive and rebuild).
- A row an old writer adds for a cause not derived yet is copied into the view as `CARRIED`, with a time-ordered id.
- Pushes and `IDENTITY_NOTIFICATIONS_CHANGED` frames follow the view (next section).

Deleting a drop or a wave, a wave's visibility change and a profile merge update the view as they update `identity_notifications`, in every mode but `off`. A merge re-keys the moved rows for their new recipient, so their groups still find them; where the target already has the row, the moved duplicate goes.

## Pushes and frames

- `off` and `shadow`: as before. Old writers queue `identity_notifications` ids in `push_notification_outbox_entries`; in `shadow` the deriver queues the copies it writes.
- `on`: the deriver queues each new row in `notification_view_push_outbox`, in the transaction that writes it, when the run is live, pushes are on, the row is less than 15 minutes old (30 for ratings) and the write filters let it through. The queue names rows by `(identity_id, source_key)`, since view ids repeat across people. The deriver's copies in `identity_notifications` are not queued. Old writers still queue their rows' old ids.
- The scheduled publisher moves both queues to SQS, as `{identity_notification_id}` and as `{view_notification: {identity_id, source_key}}`. A key leaves its queue only after SQS accepts it.
- The push worker reads a queued view row back from the view, on the writer. A row missing there was removed after it was queued (a deleted drop or wave, a re-derivation), and is acknowledged without a push. In `on` mode a queued old id is read from the view by `legacy_id` when the view has the row, and from `identity_notifications` otherwise.
- Either way the push carries the view id, the id the feed shows, and is skipped if the view row is read. The receipts that stop a second send to the same device are kept per row: by the old id for a queued old id, as before, and by `view:<identity_id>:<source_key>` for a queued view row.
- `IDENTITY_NOTIFICATIONS_CHANGED`: in `on` mode the feed runner sends it after each live batch commits, once to each person whose rows the batch wrote or removed, whether or not a push follows. Queued old ids still announce from the push worker. A replay or a rebuild sends nothing.

Drop frames (`DROP_UPDATE`, `DROP_DELETE`, reactions and ratings) and `COMPETITION_UPDATE` keep their senders until the drop index and the chain index have applied hooks to send them from.

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

`notification-view-parity.db.test.ts` checks each derived cause against its old writer: the rule's row, written as the deriver's copy, has the old writer's columns and `additional_data`, except `id`, `created_at` and `read_at`. Which people a rule picks is checked in the rules' own tests.

## Differences from today

- **Time.** A derived row's `created_at` is the event's time (block time, a drop version's effective time, a record's time), not the moment a writer ran.
- **Ids.** A derived row's id follows its time, not the order rows were written. A drop version that arrives after a later one moves the time of the rows it names first, and so their ids.
- **Edits.** Today an edit deletes the drop's rows and every row that names it, then writes the drop's rows again: unread, at the edit's time, pushed again, and without the root's group mentions. The drop rule keeps each row with its read state and the time of the version that first named its recipient, keeps the root's group mentions, and pushes only the recipients an edit adds. Rows that name an edited drop (replies, quotes) stay.
- **Filters.** Today a mute, a block, hidden content or a notification preference stops a row from being written. In `on` they hide it when read: lifting a mute or switching a kind of notification back on shows rows from the meantime, and switching it off hides older ones too. Copies and pushes are filtered as today.
- **Late rows.** A row its feed delivers after a mark-all that its time predates stays unread, as a row written after the mark would today.

Deleting a drop or a wave, and which recipients each cause reaches, are as today.

## The switch

A derived cause that no feed derives yet (`CAUSES_WITH_FEEDS` in `notify-view-flags.ts`, which each adapter extends) has its old writer skipped and nothing writing it; it is logged as `NOTIFY_DERIVED_CAUSE_WITHOUT_FEED`. Add a cause to `NOTIFY_DERIVED_CAUSES` only once its feed runs.

Rows created before the switch keep their `identity_notifications` ids, so clients that remember an id (the desktop app's last-seen id, a push in the tray) see nothing change. A derived row takes a time-based id, so no derived row may be pushed under an old id before the switch: until the switch every cut lies in the future, and the cuts and `on` come in one deploy. The operator steps are in `ops/scripts/notification-view/cli.ts` (`bin/6529 exec ts-node -r tsconfig-paths/register ops/scripts/notification-view/cli.ts <step>`), each resumable and safe to run again:

1. Deploy `dbMigrationsLoop` (creates the tables), then every service with the flags unset. Nothing changes.
2. `NOTIFY_VIEW_MODE=shadow`, with the deriver running. A cause whose feed runs joins `NOTIFY_DERIVED_CAUSES` with its cut at the switch time, so its old writer keeps writing until then. Compare the view with `identity_notifications`.
3. Before the switch: `copy-old-rows`, the bulk copy, then `seal`. `copy-old-rows` first deletes the rows the deriver wrote but does not own (in `shadow`, all of them), then copies every `identity_notifications` row the view lacks as CARRIED, with its id and read state.
4. At the switch, one deploy: `NOTIFY_VIEW_MODE=on`, with every cut at the switch time, later than the deploy.
5. After the cut: `copy-old-rows` again for the rows written since the bulk copy, then `seal` and `record-cuts`.

From `on`, a row an old writer adds is archived as it is written, so `seal` is needed only after a `copy-old-rows`. A cause that joins later gets its own cut, later than the deploy that adds it; in `on` nothing needs pruning.

A cause's old writer has to keep writing until its cut. If a cause's source takes over before the switch and its old writer stops seeing the events, set that cause's cut to that time, in `shadow`: from it the deriver writes the cause's rows and their copies, and readers see the copies at once, with their pushes. The ratings do this: they leave 6529.io at the identity switch-on, a day before the rest. `copy-old-rows` keeps such rows as the deriver's, since they lie after their cut, so at `on` each row is served once, under its view id: its id changes then, to one above every `identity_notifications` id. A client that remembered the copy's id still marks it read by that id. The desktop app shows unread rows above the highest id it has seen as new, so at `on` the early cause's rows still unread show once more as new desktop notifications. A last-seen reset, asked of the frontend for a rollback (when ids fall), would not prevent this, since these ids rise.

### Waves that stay on 6529.io

Members-only waves stay on 6529.io after the waves switch, served from MySQL as today, and so does any public wave whose groups include a hidden or private group. Their events never reach the chain's event log or the drop index, so their notifications keep coming from today's writers, before and after `on`, as CARRIED rows. A wave has moved when the chain holds a LegacyId for it.

The gate is per cause: a cause in `NOTIFY_DERIVED_CAUSES` skips its old writers for every wave. So no waves cause may join it until the gate also checks that the row's wave has moved, and skips the old writer only then. `NOTIFY_LEGACY_OUTPUT=false` stops only the deriver's copies in `identity_notifications`; old writers, including those of staying waves, keep writing.

### Handing a cause back

A cause's windows only grow. To hand a cause back to its old writer, close its window with an end later than the deploy that sets it (`CAUSE@start..end`); to derive it again, add a window that starts after that end (`CAUSE@start..end,CAUSE@later`). Run `record-cuts` after every change. A cause never leaves `NOTIFY_DERIVED_CAUSES` once logged: a rebuild derives it in its windows and restores what its old writer wrote between them from the archive.

A cause with no old writer left has no one to hand back to: ratings, once they leave 6529.io, are written only by the deriver. Ratings roll back by fixing forward: a corrected rule re-derives the same changes, under the same keys, in place. Closing their window would stop rating notifications.

## Archive and rebuild

What the view cannot derive goes into the private record log (`src/signed-records/record-log`), sealed to 6529.io's provider keys, as `notify` entries:

- `notify-archive`: CARRIED rows, up to 1,000 per entry, with their ids and read state when archived: the bulk copy's rows by `seal`, every later row as its old writer writes it;
- `notify-cuts`: each derived cause's windows, written by `record-cuts` after every change to them;
- `notify-read`: each read mark made in `shadow` or `on` through the routes, written in the same transaction as the mark: one row by its view id, or a mark-all or mark-wave with the keys of the rows it read (split across entries past 20,000 keys);
- `notify-delete`: a delete of drops or waves (a drop delete, a wave delete, a chat purge, the legacy DM purge), or a drop edit's delete of its CARRIED rows, which their old writer then writes again;
- `notify-merge`: a profile merge;
- `notify-visibility`: a wave's new visibility group.

`NotificationViewRebuild` rebuilds the view from empty with the production flags and `NOTIFY_LEGACY_OUTPUT=false`. Run it on a copy of the database, or with the feed runners, the push worker and the API's notification routes stopped: it empties the view first, and a write in between would be lost or written twice.

1. Before changing anything, it refuses when CARRIED rows are not archived yet (run `seal`), or when a logged cuts entry is not an earlier state of the flags on a cause it names. A cause's windows only grow: its open window may close and later ones may follow; causes may join later.
2. It empties the view, restores the archived rows, and applies an edit's delete of CARRIED rows where it stands in the log.
3. It replays every feed from the start. A replay writes only the view: no copies, no pushes, no frames.
4. It applies the logged deletes, merges, visibility changes and read marks in the order they were made. A mark-all or mark-wave reads the rows it lists, so a row derived after it, even for an earlier time, stays unread there as it did live.
5. Where a derived row's `identity_notifications` copy still exists, the rebuilt row names it again (`legacy_id`).

What a rebuild relies on beyond the log and the feeds:

- Feeds give profile ids as of each event; a logged merge moves rows to the target.
- The waves index stops emitting a deleted wave's events, and the drop index keeps `deleted_drops` from its tombstones, which the deriver uses to leave out rows naming a deleted drop.

## Rollback

`on` → `shadow` moves readers back to `identity_notifications`, which the deriver and the read marks kept current while `NOTIFY_LEGACY_OUTPUT` is on. Pushes already queued by view key still go out: the publisher drains that queue in every mode but `off`, and the deriver keeps the view current in `shadow`. `shadow` → `off` stops the deriver and restores every old writer; go through `shadow` so the view's queue empties first.

What clients see after `on` → `shadow`:

- The desktop app keeps the highest id it has seen (`lastSeenId`) and shows rows above it as new. View ids are time-based and above every `identity_notifications` id, so after a rollback it treats no new row as new until its last-seen id is reset. The app should reset it when the newest id in a page falls below it.
- A push sent in `on` carries a view id that the feed no longer shows, so the iOS tray can't clear it by id when the row is read.
