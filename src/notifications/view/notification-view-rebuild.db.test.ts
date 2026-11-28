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
  SIGNED_RECORD_LOG_ENTRIES_TABLE
} from '@/constants';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { userNotifier } from '@/notifications/user.notifier';
import { PushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { notificationArchive } from './notification-archive';
import { notificationDeriver } from './notification-deriver';
import { NotificationFeed } from './notification-feed-runner';
import { notificationViewRebuild } from './notification-view-rebuild';
import { notificationViewSwitch } from './notification-view-switch';
import { deriveRating } from './rules/chain-rules';
import { deriveFollow } from './rules/relay-rules';
import type { DerivedGroup } from './derived-notification';
import type {
  FollowChangedEvent,
  RatingChangedEvent
} from './notification-sources';

// The rebuild against what changes rows after they were archived: deletes,
// edits, merges and visibility changes, rows added after the switch's
// sealing, the cuts over time, and the copies a derived row names.

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
  SIGNED_RECORD_LOG_ENTRIES_TABLE
];
const T = 1_795_000_000_000;

const [actor, target, other] = [anIdentity({}), anIdentity({}), anIdentity({})];
const actorId = actor.profile_id!;
const targetId = target.profile_id!;
const otherId = other.profile_id!;

async function* loggedEntries(): AsyncGenerator<RecordLogEntry> {
  const rows = await sqlExecutor.execute<{ entry: string }>(
    `select entry from ${SIGNED_RECORD_LOG_ENTRIES_TABLE} order by id`
  );
  for (const row of rows) yield JSON.parse(row.entry) as RecordLogEntry;
}

const viewRows = () =>
  sqlExecutor
    .execute<Record<string, any>>(
      `select identity_id, source_key, id, origin, legacy_id, cause, read_at,
              related_drop_id, visibility_group_id
       from ${NOTIFICATION_VIEW_TABLE} order by identity_id, id`
    )
    .then((rows) =>
      rows.map(
        (row): Record<string, any> => ({
          ...row,
          id: Number(row.id),
          legacy_id: row.legacy_id === null ? null : Number(row.legacy_id),
          read_at: row.read_at === null ? null : Number(row.read_at)
        })
      )
    );

const react = (dropId: string) =>
  userNotifier.notifyOfDropReaction(
    {
      profile_id: actorId,
      drop_id: dropId,
      drop_author_id: targetId,
      reaction: ':fire:',
      wave_id: 'wave-1'
    },
    null
  );

const cancel = (
  reference: 'drop' | 'wave',
  value: string,
  keepDerived = false
) =>
  sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    new PushNotificationCancellationsDb(() => sqlExecutor).cancelAndDelete(
      reference,
      [value],
      { connection },
      { keepDerived }
    )
  );

const rating = (): RatingChangedEvent => ({
  height: 10,
  txIndex: 0,
  blockTimeMs: T,
  ref: '0xrating',
  origin: 'OPERATION',
  matter: 'REP',
  raterId: actorId,
  targetId,
  category: 'Art',
  oldValue: 0,
  newValue: 7,
  totalAfter: 7
});

/** A feed over a fixed list of events. */
const fixtureFeed = <E>(
  name: string,
  events: E[],
  derive: (event: E) => DerivedGroup
): NotificationFeed<E> => ({
  name,
  read: async (after, limit) => {
    const start = after === null ? 0 : Number(after);
    const batch = events.slice(start, start + limit);
    return {
      events: batch,
      next: batch.length ? String(start + batch.length) : null
    };
  },
  derive: async (event) => derive(event)
});

const ratingsFeed = (events: RatingChangedEvent[]) =>
  fixtureFeed('fixture:ratings', events, deriveRating);

describe('notification view rebuild', () => {
  const saved = Object.fromEntries(FLAGS.map((key) => [key, process.env[key]]));
  const setFlags = (flags: Partial<Record<(typeof FLAGS)[number], string>>) => {
    for (const key of FLAGS) delete process.env[key];
    process.env.USER_NOTIFIER_ACTIVATED = 'true';
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    Object.assign(process.env, flags);
  };
  const on = (flags: Partial<Record<(typeof FLAGS)[number], string>> = {}) =>
    setFlags({ NOTIFY_VIEW_MODE: 'on', ...flags });
  const rebuild = (feeds: NotificationFeed<any>[] = []) => {
    setFlags({
      NOTIFY_VIEW_MODE: 'on',
      NOTIFY_DERIVED_CAUSES: process.env.NOTIFY_DERIVED_CAUSES ?? '',
      NOTIFY_LEGACY_OUTPUT: 'false'
    });
    return notificationViewRebuild.rebuild({ entries: loggedEntries, feeds });
  };
  beforeEach(async () => {
    setFlags({});
    for (const table of TABLES) {
      await sqlExecutor.execute(`TRUNCATE TABLE ${table}`);
    }
    for (const identity of [actor, target, other]) {
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
    for (const table of TABLES) {
      await sqlExecutor.execute(`TRUNCATE TABLE ${table}`);
    }
  });

  it('archives a CARRIED row as its old writer writes it, so a rebuild brings it back', async () => {
    on();
    await notificationArchive.recordCuts({});
    await userNotifier.notifyOfIdentitySubscription({
      subscriber_id: otherId,
      subscribed_to: targetId
    });
    const live = await viewRows();
    expect(live).toEqual([
      expect.objectContaining({ origin: 'CARRIED', identity_id: targetId })
    ]);
    await rebuild();
    expect(await viewRows()).toEqual(live);
  });

  it('refuses, before changing anything, while CARRIED rows wait for the seal step', async () => {
    await react('drop-1');
    setFlags({ NOTIFY_VIEW_MODE: 'shadow' });
    while (!(await notificationViewSwitch.copyOldRows()).done) {
      // the copy at the switch writes rows unsealed
    }
    const before = await viewRows();
    await expect(rebuild()).rejects.toThrow('seal');
    expect(await viewRows()).toEqual(before);
    while (!(await notificationArchive.sealCarried()).done) {
      // the seal step
    }
    await rebuild();
    expect((await viewRows()).map((row) => row.id)).toEqual(
      before.map((row) => row.id)
    );
  });

  it('keeps the deletes of drops and waves made after rows were archived', async () => {
    on();
    await react('drop-1');
    await react('drop-2');
    await userNotifier.notifyOfWaveCreated('wave-9', actorId, [targetId], {});
    await cancel('drop', 'drop-1');
    await cancel('wave', 'wave-9');
    const live = await viewRows();
    expect(live.map((row) => row.related_drop_id)).toEqual(['drop-2']);
    const result = await rebuild();
    expect(result.changes).toBe(2);
    expect(await viewRows()).toEqual(live);
  });

  it("keeps an edit's old rows gone and the rows its old writer wrote again", async () => {
    on();
    await react('drop-1');
    // An edit deletes the drop's old rows and its writer adds them again.
    await cancel('drop', 'drop-1', true);
    await react('drop-1');
    const live = await viewRows();
    expect(live).toHaveLength(1);
    await rebuild();
    expect(await viewRows()).toEqual(live);
  });

  it('moves archived rows in a merge, keeping their read state', async () => {
    on();
    await react('drop-1');
    await identityNotificationsDb.markAllNotificationsAsRead(targetId, {});
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      identityNotificationsDb.updateIdentityIdsInNotifications(
        targetId,
        otherId,
        connection
      )
    );
    const live = await viewRows();
    expect(live).toEqual([
      expect.objectContaining({
        identity_id: otherId,
        read_at: expect.any(Number)
      })
    ]);
    await rebuild();
    expect(await viewRows()).toEqual(live);
  });

  it("applies a wave's visibility change to the rows archived before it", async () => {
    on();
    await react('drop-1');
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      wavesApiDb.updateVisibilityInNotifications(
        { waveId: 'wave-1', newVisibilityGroupId: 'group-1' },
        { connection }
      )
    );
    const live = await viewRows();
    expect(live).toEqual([
      expect.objectContaining({ visibility_group_id: 'group-1' })
    ]);
    await rebuild();
    expect(await viewRows()).toEqual(live);
  });

  it('accepts cuts logged as causes joined, and refuses a cut that changed', async () => {
    on({ NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0' });
    await notificationArchive.recordCuts({});
    on({ NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0,DROP_VOTED@5' });
    await notificationArchive.recordCuts({});
    await notificationDeriver.apply(
      [deriveRating(rating())],
      { mode: 'live', now: T },
      {}
    );
    const live = await viewRows();
    await rebuild([ratingsFeed([rating()])]);
    expect((await viewRows()).map((row) => row.id)).toEqual(
      live.map((row) => row.id)
    );
    on({ NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0,DROP_VOTED@6' });
    await expect(rebuild()).rejects.toThrow('DROP_VOTED@5');
    expect(await viewRows()).toHaveLength(1);
  });

  it('rebuilds a cause handed back to its old writer and derived again later', async () => {
    const now = Date.now();
    const opened = now - 7_200_000;
    const closed = now - 3_600_000;
    const reopened = now + 3_600_000;
    const follow = (
      eventId: string,
      subscriberId: string,
      timeMs: number
    ): FollowChangedEvent => ({
      eventId,
      timeMs,
      subscriberId,
      targetId,
      following: true,
      wasFollowing: false,
      imported: false
    });
    const first = follow('0xfirst', actorId, opened + 1);
    const between = follow('0xbetween', otherId, closed + 1);
    const again = follow('0xagain', actorId, reopened + 1);
    const derive = (event: FollowChangedEvent) =>
      notificationDeriver.apply(
        [deriveFollow(event)],
        { mode: 'live', now },
        {}
      );
    const windows = [`IDENTITY_SUBSCRIBED@${opened}`];
    const setWindows = async () => {
      on({ NOTIFY_DERIVED_CAUSES: windows.join(',') });
      await notificationArchive.recordCuts({});
    };

    await setWindows();
    await derive(first);
    // Handed back: the window closes, and the old writer writes the follow.
    windows[0] = `IDENTITY_SUBSCRIBED@${opened}..${closed}`;
    await setWindows();
    await derive(between);
    await userNotifier.notifyOfIdentitySubscription({
      subscriber_id: otherId,
      subscribed_to: targetId
    });
    // Derived again from a later start.
    windows.push(`IDENTITY_SUBSCRIBED@${reopened}`);
    await setWindows();
    await derive(again);

    const live = await viewRows();
    expect(
      live
        .map((row) => [row.origin, row.cause])
        .sort((a, b) => a.join().localeCompare(b.join()))
    ).toEqual([
      ['CARRIED', 'IDENTITY_SUBSCRIBED'],
      ['DERIVED', 'IDENTITY_SUBSCRIBED'],
      ['DERIVED', 'IDENTITY_SUBSCRIBED']
    ]);
    const feed = fixtureFeed(
      'fixture:follows',
      [first, between, again],
      deriveFollow
    );
    await rebuild([feed]);
    expect(await viewRows()).toEqual(live);

    // A cause that leaves the flags, or a window that moved, is refused.
    on({ NOTIFY_DERIVED_CAUSES: '' });
    await expect(rebuild([feed])).rejects.toThrow(
      `IDENTITY_SUBSCRIBED@${opened}`
    );
    on({
      NOTIFY_DERIVED_CAUSES: `IDENTITY_SUBSCRIBED@${opened}..${closed + 1},IDENTITY_SUBSCRIBED@${reopened}`
    });
    await expect(rebuild([feed])).rejects.toThrow(
      'differ from NOTIFY_DERIVED_CAUSES'
    );
    expect(await viewRows()).toEqual(live);
  });

  it('names again the identity_notifications copy of a rebuilt derived row', async () => {
    on({ NOTIFY_DERIVED_CAUSES: 'IDENTITY_REP@0' });
    await notificationDeriver.apply(
      [deriveRating(rating())],
      { mode: 'live', now: T },
      {}
    );
    const [copy] = await sqlExecutor.execute<{ id: number }>(
      `select id from ${IDENTITY_NOTIFICATIONS_TABLE}`
    );
    const result = await rebuild([ratingsFeed([rating()])]);
    expect(result.relinkedCopies).toBe(1);
    expect(await viewRows()).toEqual([
      expect.objectContaining({
        origin: 'DERIVED',
        legacy_id: Number(copy.id)
      })
    ]);
  });
});
