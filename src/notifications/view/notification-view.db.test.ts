import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import {
  IDENTITIES_TABLE,
  IDENTITY_MUTES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE
} from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { userNotifier } from '@/notifications/user.notifier';
import { PushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import {
  notificationDeriver,
  PUSH_LIVE_WINDOW_MS
} from './notification-deriver';
import { deriveRating, deriveVote } from './rules/chain-rules';
import {
  deriveDropCreation,
  deriveFollow,
  DropCreationFacts
} from './rules/relay-rules';
import type { DerivedGroup } from './derived-notification';
import type {
  RatingChangedEvent,
  VoteChangedEvent
} from './notification-sources';

// notification_view against MySQL: the per-cause gate on old writers, the
// deriver's two outputs in each mode, and the readers in `on` mode.

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
  PUSH_NOTIFICATION_OUTBOX_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_MUTES_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE
];
const NOW = 1_795_000_000_000;

const rater = anIdentity({});
const target = anIdentity({});
const voter = anIdentity({});
const other = anIdentity({});
const raterId = rater.profile_id!;
const targetId = target.profile_id!;
const voterId = voter.profile_id!;
const otherId = other.profile_id!;

const rating = (
  over: Partial<RatingChangedEvent> = {}
): RatingChangedEvent => ({
  height: 10,
  txIndex: 0,
  blockTimeMs: NOW,
  txId: '0xrating',
  origin: 'OPERATION',
  matter: 'REP',
  raterId: raterId,
  targetId: targetId,
  category: 'Art',
  oldValue: 0,
  newValue: 7,
  totalAfter: 7,
  ...over
});
const vote = (over: Partial<VoteChangedEvent> = {}): VoteChangedEvent => ({
  height: 11,
  txIndex: 1,
  blockTimeMs: NOW,
  ref: '0xvote',
  origin: 'OPERATION',
  waveId: 'wave-1',
  visibilityGroupId: null,
  entryDropId: 'drop-1',
  entryAuthorId: targetId,
  voterId: voterId,
  oldValue: 0,
  newValue: 3,
  entryTotalAfter: 3,
  ...over
});
const drop = (mentionedIds: string[]): DropCreationFacts => ({
  rootEventId: '0xroot',
  dropId: 'drop-2',
  waveId: 'wave-1',
  visibilityGroupId: null,
  authorId: raterId,
  deleted: false,
  versions: [
    {
      eventId: '0xroot',
      timeMs: NOW,
      reply: null,
      quotes: [],
      mentionedIds
    }
  ],
  permissionGroupMentionIds: [],
  mentionsAll: false,
  followers: [],
  readers: new Set([targetId, otherId, voterId]),
  mutedWave: new Set(),
  suppressFollowers: false
});

const apply = (groups: DerivedGroup[], mode: 'live' | 'replay' = 'live') =>
  notificationDeriver.apply(groups, { mode, now: NOW }, {});
const viewRows = () =>
  sqlExecutor.execute<{
    identity_id: string;
    id: number;
    origin: string;
    legacy_id: number | null;
    cause: string;
    read_at: number | null;
    source_family: string;
  }>(
    `select identity_id, id, origin, legacy_id, cause, read_at, source_family
     from ${NOTIFICATION_VIEW_TABLE} order by identity_id, cause`
  );
const oldRows = () =>
  sqlExecutor.execute<Record<string, any>>(
    `select * from ${IDENTITY_NOTIFICATIONS_TABLE} order by id`
  );
const outbox = () =>
  sqlExecutor
    .execute<{
      notification_id: number;
    }>(
      `select notification_id from ${PUSH_NOTIFICATION_OUTBOX_TABLE} order by notification_id`
    )
    .then((rows) => rows.map((row) => Number(row.notification_id)));
const comparable = (row: Record<string, any>) => {
  const { id: _id, created_at: _createdAt, read_at: _readAt, ...rest } = row;
  return {
    ...rest,
    additional_data:
      typeof rest.additional_data === 'string'
        ? JSON.parse(rest.additional_data)
        : rest.additional_data
  };
};

describe('notification_view', () => {
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
    for (const identity of [rater, target, voter, other]) {
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        [identity as unknown as Record<string, unknown>],
        Object.keys(identity)
      );
    }
  });
  afterEach(async () => {
    for (const key of FLAGS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await reset();
  });

  it('off: the deriver writes nothing and the old writer runs as today', async () => {
    expect(await apply([deriveRating(rating())])).toEqual({
      written: 0,
      removed: 0,
      legacyCopies: 0,
      pushed: 0
    });
    await userNotifier.notifyOfIdentityRep({
      rater_id: raterId,
      rated_id: targetId,
      amount: 7,
      rater_rating: 7,
      total: 7,
      category: 'Art'
    });
    expect(await viewRows()).toEqual([]);
    expect(await oldRows()).toHaveLength(1);
  });

  it('shadow: a derived cause skips its old writer; the deriver writes the view and the copy', async () => {
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0'
    });
    await userNotifier.notifyOfIdentityRep({
      rater_id: raterId,
      rated_id: targetId,
      amount: 7,
      rater_rating: 7,
      total: 7,
      category: 'Art'
    });
    expect(await oldRows()).toEqual([]);

    const result = await apply([deriveRating(rating())]);
    expect(result).toEqual({
      written: 1,
      removed: 0,
      legacyCopies: 1,
      pushed: 1
    });
    const [view] = await viewRows();
    const [copy] = await oldRows();
    expect(view).toMatchObject({
      identity_id: targetId,
      origin: 'DERIVED',
      legacy_id: Number(copy.id),
      source_family: 'rating'
    });
    expect(view.id).toBeGreaterThan(2 ** 52);
    expect(Number(copy.created_at)).toBe(NOW);
    expect(await outbox()).toEqual([Number(copy.id)]);

    // Applying the same source again changes nothing anywhere.
    expect(await apply([deriveRating(rating())])).toEqual({
      written: 0,
      removed: 0,
      legacyCopies: 0,
      pushed: 0
    });
    expect(await oldRows()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it('writes the same row the old writer wrote (parity)', async () => {
    await userNotifier.notifyOfIdentityRep({
      rater_id: raterId,
      rated_id: targetId,
      amount: 7,
      rater_rating: 7,
      total: 7,
      category: 'Art'
    });
    await userNotifier.notifyOfDropVote(
      {
        voter_id: voterId,
        drop_id: 'drop-1',
        drop_author_id: targetId,
        vote: 3,
        vote_change: 3,
        total_vote: 3,
        wave_id: 'wave-1'
      },
      null
    );
    const legacy = (await oldRows()).map(comparable);
    await reset();
    for (const identity of [rater, target, voter, other]) {
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        [identity as unknown as Record<string, unknown>],
        Object.keys(identity)
      );
    }
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0,DROP_VOTED@0'
    });
    await apply([deriveRating(rating()), deriveVote(vote())]);
    expect((await oldRows()).map(comparable)).toEqual(legacy);
  });

  it('shadow: a cause not yet derived is written to the view only, for comparison', async () => {
    setFlags({ NOTIFY_VIEW_MODE: 'shadow' });
    expect(await apply([deriveVote(vote())])).toEqual({
      written: 1,
      removed: 0,
      legacyCopies: 0,
      pushed: 0
    });
    expect(await viewRows()).toEqual([
      expect.objectContaining({ legacy_id: null, cause: 'DROP_VOTED' })
    ]);
    expect(await oldRows()).toEqual([]);
  });

  it('pushes only live, fresh rows', async () => {
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'DROP_VOTED@0'
    });
    await apply([deriveVote(vote({ ref: '0xreplayed' }))], 'replay');
    await apply([
      deriveVote(
        vote({ ref: '0xstale', blockTimeMs: NOW - PUSH_LIVE_WINDOW_MS - 1 })
      )
    ]);
    expect(await oldRows()).toHaveLength(2);
    expect(await outbox()).toEqual([]);
  });

  it('shadow: a cause switched at a cut leaves the events before it to the old writer', async () => {
    // The old writer wrote this vote; the deriver wrote its comparison row.
    setFlags({ NOTIFY_VIEW_MODE: 'shadow' });
    await userNotifier.notifyOfDropVote(
      {
        voter_id: voterId,
        drop_id: 'drop-1',
        drop_author_id: targetId,
        vote: 3,
        vote_change: 3,
        total_vote: 3,
        wave_id: 'wave-1'
      },
      null
    );
    await apply([deriveVote(vote())]);
    expect(await oldRows()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);

    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: `DROP_VOTED@${NOW + 1}`
    });
    // The same event again: before the cut, so no second row and no push.
    expect(await apply([deriveVote(vote())])).toMatchObject({
      legacyCopies: 0,
      pushed: 0
    });
    expect(await oldRows()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    // An event from the cut on is the deriver's.
    expect(
      await apply([deriveVote(vote({ ref: '0xafter', blockTimeMs: NOW + 1 }))])
    ).toMatchObject({ legacyCopies: 1, pushed: 1 });
    expect((await oldRows()).map((row) => Number(row.created_at))).toEqual([
      expect.any(Number),
      NOW + 1
    ]);
    expect(await outbox()).toHaveLength(2);
  });

  it('applies the old write filters: a muted actor writes no row', async () => {
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0'
    });
    await sqlExecutor.execute(
      `insert into ${IDENTITY_MUTES_TABLE} (muter_id, muted_identity_id, created_at)
       values (:muter, :muted, :now)`,
      { muter: targetId, muted: raterId, now: NOW }
    );
    expect((await apply([deriveRating(rating())])).written).toBe(0);
    expect(await viewRows()).toEqual([]);
    expect(await oldRows()).toEqual([]);
  });

  it('replaces a group: a dropped recipient goes, a kept one keeps its read state', async () => {
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: 'IDENTITY_MENTIONED@0'
    });
    await apply([deriveDropCreation(drop([targetId, otherId]))]);
    const copies = await oldRows();
    expect(copies).toHaveLength(2);
    await sqlExecutor.execute(
      `update ${NOTIFICATION_VIEW_TABLE} set read_at = 5 where identity_id = :id`,
      { id: targetId }
    );
    const result = await apply([deriveDropCreation(drop([targetId]))]);
    expect(result).toMatchObject({ removed: 1, written: 0 });
    expect(await viewRows()).toEqual([
      expect.objectContaining({ identity_id: targetId, read_at: 5 })
    ]);
    const remaining = await oldRows();
    expect(remaining.map((row) => row.identity_id)).toEqual([targetId]);
    const cancelled = await sqlExecutor.execute<{ notification_id: number }>(
      `select notification_id from ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE}`
    );
    const removedCopy = copies.find((row) => row.identity_id === otherId);
    expect(cancelled.map((row) => Number(row.notification_id))).toEqual([
      Number(removedCopy?.id)
    ]);
  });

  it('removes the view rows of a deleted drop with its old rows', async () => {
    setFlags({ NOTIFY_VIEW_MODE: 'shadow' });
    await apply([deriveDropCreation(drop([targetId]))]);
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      new PushNotificationCancellationsDb(() => sqlExecutor).cancelAndDelete(
        'drop',
        ['drop-2'],
        { connection }
      )
    );
    expect(await viewRows()).toEqual([]);
  });

  describe('on', () => {
    beforeEach(() => {
      setFlags({
        NOTIFY_VIEW_MODE: 'on',
        NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0'
      });
    });

    const page = () =>
      identityNotificationsDb.findNotifications({
        identity_id: targetId,
        id_less_than: null,
        limit: 10,
        eligible_group_ids: [],
        cause: null,
        cause_exclude: null,
        unread_only: false
      });
    const unread = () =>
      identityNotificationsDb.countUnreadNotificationsForIdentity(targetId, []);

    it('reads derived rows and copies of not-yet-derived causes from the view', async () => {
      await apply([deriveRating(rating())]);
      await userNotifier.notifyOfIdentitySubscription({
        subscriber_id: otherId,
        subscribed_to: targetId
      });
      const rows = await page();
      expect(rows.map((row) => row.cause)).toEqual(
        expect.arrayContaining([
          IdentityNotificationCause.IDENTITY_REP,
          IdentityNotificationCause.IDENTITY_SUBSCRIBED
        ])
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.id > 2 ** 52)).toBe(true);
      expect(await unread()).toBe(2);
      expect(await viewRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: 'CARRIED',
            source_family: 'carried'
          }),
          expect.objectContaining({
            origin: 'DERIVED',
            source_family: 'rating'
          })
        ])
      );
    });

    it('marks read by the view id or the old id, in both tables', async () => {
      await apply([deriveRating(rating())]);
      await userNotifier.notifyOfIdentitySubscription({
        subscriber_id: otherId,
        subscribed_to: targetId
      });
      const [derived, carried] = await Promise.all([
        sqlExecutor.oneOrNull<{ id: number; legacy_id: number }>(
          `select id, legacy_id from ${NOTIFICATION_VIEW_TABLE} where origin = 'DERIVED'`
        ),
        sqlExecutor.oneOrNull<{ id: number; legacy_id: number }>(
          `select id, legacy_id from ${NOTIFICATION_VIEW_TABLE} where origin = 'CARRIED'`
        )
      ]);
      await identityNotificationsDb.updateNotificationReadAt({
        id: Number(derived!.id),
        identity_id: targetId,
        readAt: 11
      });
      // An app that still holds the old id from a push.
      await identityNotificationsDb.updateNotificationReadAt({
        id: Number(carried!.legacy_id),
        identity_id: targetId,
        readAt: 12
      });
      expect(await unread()).toBe(0);
      expect(
        (await oldRows())
          .map((row) => Number(row.read_at))
          .sort((a, b) => a - b)
      ).toEqual([11, 12]);

      await identityNotificationsDb.updateNotificationReadAt({
        id: Number(derived!.id),
        identity_id: otherId,
        readAt: null
      });
      expect(await unread()).toBe(0);
    });

    it('marks all and a wave read in both tables, and logs each mark', async () => {
      setFlags({
        NOTIFY_VIEW_MODE: 'on',
        NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0,DROP_VOTED@0'
      });
      await apply([
        deriveRating(rating()),
        deriveVote(vote()),
        deriveVote(vote({ ref: '0xvote2' }))
      ]);
      expect(
        await identityNotificationsDb.markWaveNotificationsAsRead(
          'wave-1',
          targetId,
          {}
        )
      ).toBe(2);
      await identityNotificationsDb.markAllNotificationsAsRead(targetId, {});
      expect(await unread()).toBe(0);
      expect((await oldRows()).every((row) => row.read_at !== null)).toBe(true);
      const logged = await sqlExecutor.execute<{ entry: string }>(
        `select entry from ${SIGNED_RECORD_LOG_ENTRIES_TABLE} where lane = 'notify' order by id`
      );
      expect(
        logged.map((row) => {
          const { body } = JSON.parse(row.entry);
          return [body.type, body.scope];
        })
      ).toEqual([
        ['notify-read', 'wave'],
        ['notify-read', 'all']
      ]);
    });

    it('a cause switched at a cut keeps the old row of an event before it, once', async () => {
      setFlags({ NOTIFY_VIEW_MODE: 'on' });
      await userNotifier.notifyOfIdentitySubscription({
        subscriber_id: otherId,
        subscribed_to: targetId
      });
      setFlags({
        NOTIFY_VIEW_MODE: 'on',
        NOTIFY_DERIVED_CAUSES: `IDENTITY_SUBSCRIBED@${NOW + 1}`
      });
      const follow = (subscriberId: string, timeMs: number) =>
        deriveFollow({
          eventId: `0xfollow-${subscriberId}`,
          timeMs,
          subscriberId,
          targetId,
          following: true,
          wasFollowing: false,
          imported: false
        });
      // The old writer's row stands for the event before the cut.
      expect((await apply([follow(otherId, NOW)])).written).toBe(0);
      expect((await page()).map((row) => row.cause)).toEqual([
        IdentityNotificationCause.IDENTITY_SUBSCRIBED
      ]);
      expect(await unread()).toBe(1);
      // A follow from the cut on is derived.
      expect((await apply([follow(voterId, NOW + 1)])).written).toBe(1);
      expect(await page()).toHaveLength(2);
      expect(await unread()).toBe(2);
    });

    it('writes no view row for a cause the deriver does not own yet', async () => {
      expect((await apply([deriveVote(vote())])).written).toBe(0);
      expect(await viewRows()).toEqual([]);
    });
  });
});
