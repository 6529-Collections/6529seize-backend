import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import {
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_CURSORS_TABLE,
  NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
  NOTIFICATION_VIEW_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { userNotifier } from '@/notifications/user.notifier';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { notificationDeriver } from './notification-deriver';
import {
  FeedBatch,
  notificationFeedRunner,
  NotificationFeed
} from './notification-feed-runner';
import { notificationArchive } from './notification-archive';
import { notificationSourceKey } from './notification-view-ids';
import { notificationViewRebuild } from './notification-view-rebuild';
import { notificationViewSwitch } from './notification-view-switch';
import { deriveVote } from './rules/chain-rules';
import { deriveDropCreation } from './rules/relay-rules';
import type { VoteChangedEvent } from './notification-sources';

// The view's life against MySQL: the feed runner and its cursors, batched
// copies, the switch to `on` (prune and copy of old rows), the archive, and
// a rebuild from empty that gives the same answers.

const FLAGS = [
  'NOTIFY_VIEW_MODE',
  'NOTIFY_DERIVED_CAUSES',
  'NOTIFY_LEGACY_OUTPUT',
  'USER_NOTIFIER_ACTIVATED',
  'PUSH_NOTIFICATIONS_ACTIVATED'
] as const;
const TABLES = [
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE,
  NOTIFICATION_VIEW_CURSORS_TABLE,
  NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  IDENTITIES_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  WAVES_TABLE
];
const T = 1_795_000_000_000;

const author = anIdentity({});
const voters = [anIdentity({}), anIdentity({}), anIdentity({})];
const fan = anIdentity({});
const authorId = author.profile_id!;
const wave = aWave({ visibility_group_id: null });
const fanId = fan.profile_id!;

const vote = (index: number, timeMs: number): VoteChangedEvent => ({
  height: 100 + index,
  txIndex: 0,
  blockTimeMs: timeMs,
  ref: `0xvote${index}`,
  origin: 'OPERATION',
  waveId: wave.id,
  visibilityGroupId: null,
  entryDropId: 'drop-1',
  entryAuthorId: authorId,
  voterId: voters[index % voters.length].profile_id!,
  oldValue: 0,
  newValue: index + 1,
  entryTotalAfter: index + 1
});

/** A feed over a fixed list; its cursor is the count read so far. */
class ListFeed implements NotificationFeed<VoteChangedEvent> {
  readonly name = 'fixture:votes';
  constructor(readonly events: VoteChangedEvent[]) {}
  async read(
    after: string | null,
    limit: number
  ): Promise<FeedBatch<VoteChangedEvent>> {
    const start = after === null ? 0 : Number(after);
    const events = this.events.slice(start, start + limit);
    return {
      events,
      next: events.length ? String(start + events.length) : null
    };
  }
  async derive(event: VoteChangedEvent) {
    return deriveVote(event);
  }
}

const page = () =>
  identityNotificationsDb.findNotifications({
    identity_id: authorId,
    id_less_than: null,
    limit: 50,
    eligible_group_ids: [],
    cause: null,
    cause_exclude: null,
    unread_only: false
  });
const answers = async () => ({
  page: (await page()).map((row) => ({
    id: row.id,
    cause: row.cause,
    created_at: row.created_at,
    read_at: row.read_at,
    actor: row.additional_identity_id,
    data: row.additional_data
  })),
  unread: await identityNotificationsDb.countUnreadNotificationsForIdentity(
    authorId,
    []
  )
});

async function* loggedEntries(): AsyncGenerator<RecordLogEntry> {
  const rows = await sqlExecutor.execute<{ entry: string }>(
    `select entry from ${SIGNED_RECORD_LOG_ENTRIES_TABLE} order by id`
  );
  for (const row of rows) yield JSON.parse(row.entry) as RecordLogEntry;
}

describe('notification view lifecycle', () => {
  const saved = Object.fromEntries(FLAGS.map((key) => [key, process.env[key]]));
  const setFlags = (flags: Partial<Record<(typeof FLAGS)[number], string>>) => {
    for (const key of FLAGS) delete process.env[key];
    process.env.USER_NOTIFIER_ACTIVATED = 'true';
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    Object.assign(process.env, flags);
  };
  const reset = async () => {
    for (const table of TABLES) {
      await sqlExecutor.execute(`TRUNCATE TABLE ${table}`);
    }
  };
  beforeEach(async () => {
    setFlags({});
    await reset();
    for (const identity of [author, fan, ...voters]) {
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        [identity as unknown as Record<string, unknown>],
        Object.keys(identity)
      );
    }
    const [waveRow] = withWaves([wave]).rows;
    await sqlExecutor.bulkInsert(WAVES_TABLE, [waveRow], Object.keys(waveRow));
  });
  afterEach(async () => {
    for (const key of FLAGS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await reset();
  });

  describe('feed runner', () => {
    it('derives in batches, commits the cursor with the rows, and resumes', async () => {
      setFlags({ NOTIFY_VIEW_MODE: 'shadow' });
      const feed = new ListFeed([0, 1, 2, 3, 4].map((i) => vote(i, T + i)));
      const first = await notificationFeedRunner.run(feed, {
        mode: 'replay',
        batchSize: 2,
        maxBatches: 2
      });
      expect(first).toMatchObject({ events: 4, batches: 2 });
      const rest = await notificationFeedRunner.run(feed, {
        mode: 'replay',
        batchSize: 2
      });
      expect(rest).toMatchObject({ events: 1, batches: 1 });
      expect(
        await notificationFeedRunner.run(feed, { mode: 'replay', batchSize: 2 })
      ).toMatchObject({ events: 0, batches: 0 });
      const rows = await sqlExecutor.execute(
        `select id from ${NOTIFICATION_VIEW_TABLE}`
      );
      expect(rows).toHaveLength(5);
    });

    it('does not move a cursor while the view is off', async () => {
      const feed = new ListFeed([vote(0, T)]);
      expect(
        await notificationFeedRunner.run(feed, { mode: 'live' })
      ).toMatchObject({ events: 0 });
      expect(
        await sqlExecutor.execute(
          `select * from ${NOTIFICATION_VIEW_CURSORS_TABLE}`
        )
      ).toEqual([]);
    });
  });

  it('writes the old-table copies of a large group in bulk, one per recipient', async () => {
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'IDENTITY_MENTIONED@0'
    });
    const recipients = Array.from({ length: 1200 }, (_, i) => `recipient-${i}`);
    await notificationDeriver.apply(
      [
        deriveDropCreation({
          rootEventId: '0xbig',
          dropId: 'drop-big',
          waveId: wave.id,
          visibilityGroupId: null,
          authorId,
          deleted: false,
          versions: [
            {
              eventId: '0xbig',
              timeMs: T,
              reply: null,
              quotes: [],
              mentionedIds: recipients
            }
          ],
          permissionGroupMentionIds: [],
          mentionsAll: false,
          followers: [],
          readers: new Set(recipients),
          mutedWave: new Set(),
          suppressFollowers: false
        })
      ],
      { mode: 'replay', now: T },
      {}
    );
    const mismatched = await sqlExecutor.execute(
      `select v.identity_id from ${NOTIFICATION_VIEW_TABLE} v
       left join ${IDENTITY_NOTIFICATIONS_TABLE} n on n.id = v.legacy_id
       where n.identity_id is null or n.identity_id <> v.identity_id`
    );
    expect(mismatched).toEqual([]);
    expect(
      await sqlExecutor.oneOrNull<{ n: number }>(
        `select count(*) as n from ${IDENTITY_NOTIFICATIONS_TABLE}`
      )
    ).toEqual({ n: 1200 });
  });

  it('switches to on, archives, and rebuilds from empty to the same answers', async () => {
    // Shadow: the deriver owns DROP_VOTED; follows still come from their
    // old writer.
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'DROP_VOTED@0'
    });
    const announced = jest
      .spyOn(wsListenersNotifier, 'notifyAboutIdentityNotificationsChanged')
      .mockResolvedValue(undefined);
    const before = [vote(0, T - 2000), vote(1, T - 1000)];
    const feed = new ListFeed(before);
    await notificationFeedRunner.run(feed, { mode: 'live', now: T });
    // In shadow the copies are pushed by id and the push worker announces them.
    expect(
      await sqlExecutor.execute(
        `select notification_id from ${PUSH_NOTIFICATION_OUTBOX_TABLE}`
      )
    ).toHaveLength(2);
    expect(announced).not.toHaveBeenCalled();
    await userNotifier.notifyOfIdentitySubscription({
      subscriber_id: fanId,
      subscribed_to: authorId
    });
    const follow = await sqlExecutor.oneOrNull<{ id: number }>(
      `select id from ${IDENTITY_NOTIFICATIONS_TABLE} where cause = 'IDENTITY_SUBSCRIBED'`
    );
    await identityNotificationsDb.updateNotificationReadAt({
      id: Number(follow!.id),
      identity_id: authorId,
      readAt: 42
    });

    // The switch: votes before T stay as they were written; from T the
    // deriver owns them.
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: `DROP_VOTED@${T}`
    });
    while (!(await notificationViewSwitch.copyOldRows(1)).done) {
      // One old row per batch, to cross batch edges.
    }
    setFlags({
      NOTIFY_VIEW_MODE: 'on',
      NOTIFY_DERIVED_CAUSES: `DROP_VOTED@${T}`
    });
    const oldIds = (
      await sqlExecutor.execute<{ id: number }>(
        `select id from ${IDENTITY_NOTIFICATIONS_TABLE} order by id`
      )
    ).map((row) => Number(row.id));
    const copied = await sqlExecutor.execute<{
      id: number;
      origin: string;
      source_key: string;
      identity_id: string;
      read_at: number | null;
    }>(
      `select id, origin, source_key, identity_id, read_at from ${NOTIFICATION_VIEW_TABLE} order by id`
    );
    expect(copied.map((row) => Number(row.id))).toEqual(oldIds);
    expect(copied.every((row) => row.origin === 'CARRIED')).toBe(true);
    for (const row of copied) {
      expect(row.source_key).toBe(
        notificationSourceKey('carried', String(row.id), row.identity_id)
      );
    }

    // After the switch: a new vote is derived; old writers keep writing
    // follows, copied as they go; marks are made through the routes.
    const queuedOldIds = await sqlExecutor.execute(
      `select notification_id from ${PUSH_NOTIFICATION_OUTBOX_TABLE}`
    );
    feed.events.push(vote(2, T + 1000));
    await notificationFeedRunner.run(feed, { mode: 'live', now: T + 1000 });
    expect((await notificationViewSwitch.copyOldRows()).rows).toBe(0);
    // In on the new row is pushed from the view, by key, and announced once
    // its batch commits.
    const queued = await sqlExecutor.execute<{ cause: string; id: number }>(
      `select v.cause, v.id from ${NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE} o
       join ${NOTIFICATION_VIEW_TABLE} v
         on v.identity_id = o.identity_id and v.source_key = o.source_key`
    );
    expect(queued).toEqual([expect.objectContaining({ cause: 'DROP_VOTED' })]);
    expect(Number(queued[0].id)).toBeGreaterThan(2 ** 52);
    // Its identity_notifications copy is not queued by id.
    expect(
      await sqlExecutor.execute(
        `select notification_id from ${PUSH_NOTIFICATION_OUTBOX_TABLE}`
      )
    ).toEqual(queuedOldIds);
    expect(announced.mock.calls).toEqual([[[authorId]]]);
    await userNotifier.notifyOfIdentitySubscription({
      subscriber_id: voters[0].profile_id!,
      subscribed_to: authorId
    });
    const newest = (await page())[0];
    await identityNotificationsDb.updateNotificationReadAt({
      id: newest.id,
      identity_id: authorId,
      readAt: T + 5000
    });
    await identityNotificationsDb.markWaveNotificationsAsRead(
      wave.id,
      authorId,
      {}
    );
    expect((await answers()).page).toHaveLength(5);

    // The archive: every copied row, the cuts, and the marks are logged.
    while (!(await notificationArchive.sealCarried(2)).done) {
      // Two rows per entry.
    }
    await notificationArchive.recordCuts({});
    const live = await answers();

    // Rebuild from empty: the log and the feed are all it reads.
    setFlags({
      NOTIFY_VIEW_MODE: 'on',
      NOTIFY_DERIVED_CAUSES: `DROP_VOTED@${T}`,
      NOTIFY_LEGACY_OUTPUT: 'false'
    });
    const result = await notificationViewRebuild.rebuild({
      entries: loggedEntries(),
      feeds: [feed]
    });
    expect(result.archivedRows).toBe(4);
    expect(result.receipts).toBe(2);
    expect(await answers()).toEqual(live);
    // A rebuild queues no push and announces nothing.
    expect(
      await sqlExecutor.execute(
        `select identity_id from ${NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE}`
      )
    ).toHaveLength(1);
    expect(announced).toHaveBeenCalledTimes(1);
    announced.mockRestore();
  });

  it('refuses a rebuild whose logged cuts differ from the flags', async () => {
    setFlags({
      NOTIFY_VIEW_MODE: 'on',
      NOTIFY_DERIVED_CAUSES: `DROP_VOTED@${T}`
    });
    await notificationArchive.recordCuts({});
    setFlags({
      NOTIFY_VIEW_MODE: 'on',
      NOTIFY_DERIVED_CAUSES: `DROP_VOTED@${T + 1}`,
      NOTIFY_LEGACY_OUTPUT: 'false'
    });
    await expect(
      notificationViewRebuild.rebuild({ entries: loggedEntries(), feeds: [] })
    ).rejects.toThrow('cuts');
  });
});
