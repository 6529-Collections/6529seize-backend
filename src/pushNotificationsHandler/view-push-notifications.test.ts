import {
  sendIdentityNotificationsBatch,
  sendViewNotificationsBatch
} from './identityPushNotifications';
import { getDataSource } from '@/db';
import { identityMutesDb } from '@/api/identity-mutes/identity-mutes.db';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import type { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { sendIdentityPushGroups } from './identity-push-delivery';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { pushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import {
  notificationViewPushDb,
  ViewPushRow
} from '@/notifications/view/notification-view-push.db';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '@/entities/IIdentityNotification';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { viewPushKey } from './push-key';

// Pushes of notification_view rows: queued by key, sent under the id the
// feed shows, remembered per key because view ids repeat across people.

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: { getIdentityAndConsolidationsByIdentityKey: jest.fn() }
}));
jest.mock('@/notifications/push-notification-cancellations.db', () => ({
  pushNotificationCancellationsDb: { findCancelledIds: jest.fn() }
}));
jest.mock('@/notifications/view/notification-view-push.db', () => ({
  notificationViewPushDb: {
    findRows: jest.fn(),
    findRowsByLegacyIds: jest.fn()
  }
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {
    notifyAboutIdentityNotificationsChanged: jest
      .fn()
      .mockResolvedValue(undefined)
  }
}));
jest.mock('@/api/identity-mutes/identity-mutes.db', () => ({
  identityMutesDb: { filterMutedNotificationRows: jest.fn() }
}));
jest.mock('@/content-moderation/content-moderation.db', () => ({
  contentModerationDb: {
    filterBlockedNotificationRows: jest.fn(),
    filterUnavailableDropNotificationRows: jest.fn()
  }
}));
jest.mock('./identity-push-delivery', () => ({
  sendIdentityPushGroups: jest.fn()
}));

const SHARED_ID = 1_795_000_000_000 * 4096 + 7;
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const viewRow = (over: Partial<ViewPushRow>): ViewPushRow => ({
  identity_id: 'alice',
  source_key: KEY_A,
  id: SHARED_ID,
  legacy_id: null,
  additional_identity_id: 'follower',
  related_drop_id: null,
  related_drop_part_no: null,
  related_drop_2_id: null,
  related_drop_2_part_no: null,
  cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
  additional_data: {},
  created_at: 1_795_000_000_000,
  read_at: null,
  visibility_group_id: null,
  wave_id: null,
  ...over
});

function withOldRows(rows: Partial<IdentityNotificationEntity>[]) {
  jest.mocked(getDataSource).mockReturnValue({
    getRepository: (entity: unknown) => {
      if (entity === IdentityNotificationEntity) {
        return { find: async () => rows };
      }
      if (entity === PushNotificationDevice) {
        return {
          findBy: async ({ profile_id }: { profile_id: string }) => [
            {
              profile_id,
              device_id: `${profile_id}-phone`,
              token: `${profile_id}-token`,
              platform: 'android'
            }
          ],
          createQueryBuilder: () => ({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([])
          })
        };
      }
      return { findOneBy: async () => null };
    }
  } as unknown as ReturnType<typeof getDataSource>);
}

const sentMessages = () =>
  jest.mocked(sendIdentityPushGroups).mock.calls.flatMap(([messages]) =>
    messages.map((message) => ({
      id: message.input.notification_id,
      key: message.pushKey,
      to: message.identityId
    }))
  );

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NOTIFY_VIEW_MODE;
  withOldRows([]);
  jest
    .mocked(identityFetcher.getIdentityAndConsolidationsByIdentityKey)
    .mockImplementation(
      async ({ identityKey }) =>
        ({
          id: identityKey,
          handle: identityKey,
          normalised_handle: identityKey
        }) as ApiIdentity
    );
  jest
    .mocked(identityMutesDb.filterMutedNotificationRows)
    .mockImplementation(async (rows) => rows);
  jest
    .mocked(contentModerationDb.filterBlockedNotificationRows)
    .mockImplementation(async (rows) => rows);
  jest
    .mocked(contentModerationDb.filterUnavailableDropNotificationRows)
    .mockImplementation(async (rows) => rows);
  jest.mocked(notificationViewPushDb.findRows).mockResolvedValue([]);
  jest.mocked(notificationViewPushDb.findRowsByLegacyIds).mockResolvedValue([]);
  jest.mocked(sendIdentityPushGroups).mockResolvedValue([]);
});

afterAll(() => {
  delete process.env.NOTIFY_VIEW_MODE;
});

describe('sendViewNotificationsBatch', () => {
  const alice = { identity_id: 'alice', source_key: KEY_A };
  const bob = { identity_id: 'bob', source_key: KEY_B };

  it('sends two people the same view id, each under its own key', async () => {
    jest
      .mocked(notificationViewPushDb.findRows)
      .mockResolvedValue([viewRow(alice), viewRow(bob)]);
    expect(await sendViewNotificationsBatch([alice, bob, alice])).toEqual([]);
    expect(notificationViewPushDb.findRows).toHaveBeenCalledWith([alice, bob]);
    expect(sentMessages()).toEqual([
      { id: SHARED_ID, key: viewPushKey(alice), to: 'alice' },
      { id: SHARED_ID, key: viewPushKey(bob), to: 'bob' }
    ]);
    // The feed runner announced these rows when it wrote them.
    expect(
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged
    ).not.toHaveBeenCalled();
  });

  it('applies a mute to its own row when ids repeat', async () => {
    jest
      .mocked(notificationViewPushDb.findRows)
      .mockResolvedValue([viewRow(alice), viewRow(bob)]);
    jest
      .mocked(identityMutesDb.filterMutedNotificationRows)
      .mockImplementation(async (rows) =>
        rows.filter((row) => row.identity_id !== 'alice')
      );
    expect(await sendViewNotificationsBatch([alice, bob])).toEqual([]);
    expect(sentMessages().map((message) => message.to)).toEqual(['bob']);
  });

  it('skips a read row and acknowledges a removed one', async () => {
    jest
      .mocked(notificationViewPushDb.findRows)
      .mockResolvedValue([viewRow({ ...alice, read_at: 1 })]);
    expect(await sendViewNotificationsBatch([alice, bob])).toEqual([]);
    expect(sendIdentityPushGroups).not.toHaveBeenCalled();
    expect(
      pushNotificationCancellationsDb.findCancelledIds
    ).not.toHaveBeenCalled();
  });

  it('returns the keys to retry', async () => {
    jest
      .mocked(notificationViewPushDb.findRows)
      .mockResolvedValue([viewRow(alice), viewRow(bob)]);
    jest.mocked(sendIdentityPushGroups).mockResolvedValue([viewPushKey(bob)]);
    expect(await sendViewNotificationsBatch([alice, bob])).toEqual([bob]);
  });

  it('retries the whole batch when the filters fail', async () => {
    jest
      .mocked(notificationViewPushDb.findRows)
      .mockResolvedValue([viewRow(alice)]);
    jest
      .mocked(identityMutesDb.filterMutedNotificationRows)
      .mockRejectedValue(new Error('filter unavailable'));
    expect(await sendViewNotificationsBatch([alice, bob])).toEqual([
      alice,
      bob
    ]);
    expect(sendIdentityPushGroups).not.toHaveBeenCalled();
  });
});

describe('sendIdentityNotificationsBatch in on mode', () => {
  const oldRow = (id: number) => ({
    id,
    identity_id: 'alice',
    additional_identity_id: 'follower',
    cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
    additional_data: {} as unknown as string,
    read_at: null
  });

  it('sends a queued old id with the id and read state the feed shows', async () => {
    process.env.NOTIFY_VIEW_MODE = 'on';
    withOldRows([oldRow(41), oldRow(42), oldRow(43)]);
    jest
      .mocked(notificationViewPushDb.findRowsByLegacyIds)
      .mockResolvedValue([
        viewRow({ legacy_id: 41, id: SHARED_ID }),
        viewRow({ legacy_id: 42, source_key: KEY_B, read_at: 5 })
      ]);
    expect(await sendIdentityNotificationsBatch([41, 42, 43])).toEqual([]);
    expect(notificationViewPushDb.findRowsByLegacyIds).toHaveBeenCalledWith([
      41, 42, 43
    ]);
    // 42 was read in the view; 43 has no view row yet and goes as before.
    expect(sentMessages()).toEqual([
      { id: SHARED_ID, key: 41, to: 'alice' },
      { id: 43, key: 43, to: 'alice' }
    ]);
    expect(
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged
    ).toHaveBeenCalledWith(['alice', 'alice', 'alice']);
  });

  it('does not read the view outside on mode', async () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    withOldRows([oldRow(41)]);
    expect(await sendIdentityNotificationsBatch([41])).toEqual([]);
    expect(notificationViewPushDb.findRowsByLegacyIds).not.toHaveBeenCalled();
    expect(sentMessages()).toEqual([{ id: 41, key: 41, to: 'alice' }]);
  });
});
