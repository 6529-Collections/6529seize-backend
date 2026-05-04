import { ApiDropGroupMention } from '@/api/generated/models/ApiDropGroupMention';
import { NotificationsApiService } from '@/api/notifications/notifications.api.service';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';

describe('NotificationsApiService wave notification preferences', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createService({
    subscriptionState = {
      is_following: true,
      subscribed_to_all_drops: false
    },
    enabledGroups = [] as DropGroupMention[]
  } = {}) {
    const connection = {} as any;
    const identitySubscriptionsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      getWaveSubscriptionState: jest.fn().mockResolvedValue(subscriptionState),
      countWaveSubscribersForUpdate: jest.fn().mockResolvedValue(0),
      subscribeToAllDrops: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromAllDrops: jest.fn().mockResolvedValue(undefined)
    };
    const waveGroupNotificationSubscriptionsDb = {
      getEnabledGroups: jest.fn().mockResolvedValue(enabledGroups),
      replaceEnabledGroups: jest.fn().mockResolvedValue(undefined),
      deleteForWave: jest.fn().mockResolvedValue(undefined)
    };
    const service = new NotificationsApiService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      identitySubscriptionsDb as any,
      {} as any,
      waveGroupNotificationSubscriptionsDb as any
    );
    return {
      service,
      connection,
      identitySubscriptionsDb,
      waveGroupNotificationSubscriptionsDb
    };
  }

  it('returns both subscribed state and enabled group notifications', async () => {
    const { service } = createService({
      subscriptionState: {
        is_following: true,
        subscribed_to_all_drops: true
      },
      enabledGroups: [DropGroupMention.ALL]
    });

    await expect(
      service.getWaveSubscription('profile-1', 'wave-1')
    ).resolves.toEqual({
      subscribed: true,
      enabled_group_notifications: [ApiDropGroupMention.All]
    });
  });

  it('treats an empty update request as subscribed=true', async () => {
    const { service, connection, identitySubscriptionsDb } = createService();
    await expect(
      service.updateWaveSubscription('profile-1', 'wave-1', {})
    ).resolves.toEqual({
      subscribed: true,
      enabled_group_notifications: []
    });

    expect(identitySubscriptionsDb.subscribeToAllDrops).toHaveBeenCalledWith(
      'profile-1',
      'wave-1',
      connection
    );
    expect(
      identitySubscriptionsDb.countWaveSubscribersForUpdate
    ).toHaveBeenCalledWith('wave-1', connection);
  });

  it('replaces enabled group notifications for followers', async () => {
    const { service, connection, waveGroupNotificationSubscriptionsDb } =
      createService();
    await expect(
      service.updateWaveSubscription('profile-1', 'wave-1', {
        enabled_group_notifications: [ApiDropGroupMention.All]
      })
    ).resolves.toEqual({
      subscribed: false,
      enabled_group_notifications: [ApiDropGroupMention.All]
    });

    expect(
      waveGroupNotificationSubscriptionsDb.replaceEnabledGroups
    ).toHaveBeenCalledWith(
      {
        identityId: 'profile-1',
        waveId: 'wave-1',
        mentionedGroups: [DropGroupMention.ALL]
      },
      connection
    );
  });

  it('does not persist enabled group notifications for non-followers', async () => {
    const { service, waveGroupNotificationSubscriptionsDb } = createService({
      subscriptionState: {
        is_following: false,
        subscribed_to_all_drops: false
      }
    });
    await expect(
      service.updateWaveSubscription('profile-1', 'wave-1', {
        enabled_group_notifications: [ApiDropGroupMention.All]
      })
    ).resolves.toEqual({
      subscribed: false,
      enabled_group_notifications: []
    });

    expect(
      waveGroupNotificationSubscriptionsDb.replaceEnabledGroups
    ).not.toHaveBeenCalled();
  });

  it('skips the cap check when the user is already subscribed', async () => {
    const { service, identitySubscriptionsDb } = createService({
      subscriptionState: {
        is_following: true,
        subscribed_to_all_drops: true
      }
    });

    await expect(
      service.updateWaveSubscription('profile-1', 'wave-1', {
        subscribed: true,
        enabled_group_notifications: [ApiDropGroupMention.All]
      })
    ).resolves.toEqual({
      subscribed: true,
      enabled_group_notifications: [ApiDropGroupMention.All]
    });

    expect(
      identitySubscriptionsDb.countWaveSubscribersForUpdate
    ).not.toHaveBeenCalled();
    expect(identitySubscriptionsDb.subscribeToAllDrops).not.toHaveBeenCalled();
  });

  it('returns the persisted subscribed state for non-followers', async () => {
    const { service, identitySubscriptionsDb } = createService({
      subscriptionState: {
        is_following: false,
        subscribed_to_all_drops: false
      }
    });

    await expect(
      service.updateWaveSubscription('profile-1', 'wave-1', {
        subscribed: true
      })
    ).resolves.toEqual({
      subscribed: false,
      enabled_group_notifications: []
    });

    expect(
      identitySubscriptionsDb.countWaveSubscribersForUpdate
    ).not.toHaveBeenCalled();
    expect(identitySubscriptionsDb.subscribeToAllDrops).not.toHaveBeenCalled();
  });

  it('skips drop notifications when a related drop is missing', async () => {
    const notificationsReader = {
      getNotificationsForIdentity: jest.fn().mockResolvedValue({
        notifications: [
          {
            id: 1,
            created_at: 1000,
            read_at: null,
            cause: IdentityNotificationCause.DROP_QUOTED,
            data: {
              quote_drop_id: 'quote-drop',
              quote_drop_part: 1,
              quote_drop_author_id: 'quote-author',
              quoted_drop_id: 'deleted-original-drop',
              quoted_drop_part: 1,
              quoted_drop_author_id: 'recipient',
              wave_id: 'wave-1'
            }
          }
        ],
        total_unread: 1
      })
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };
    const identityFetcher = {
      getOverviewsByIds: jest.fn().mockResolvedValue({
        'quote-author': { id: 'quote-author' }
      })
    };
    const dropsService = {
      findDropsByIds: jest.fn().mockResolvedValue({
        'quote-drop': { id: 'quote-drop' }
      })
    };
    const service = new NotificationsApiService(
      notificationsReader as any,
      userGroupsService as any,
      identityFetcher as any,
      dropsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(
      service.getNotifications(
        {
          id_less_than: null,
          limit: 20,
          cause: null,
          cause_exclude: null,
          unread_only: false
        },
        {
          getActingAsId: () => 'recipient'
        } as any
      )
    ).resolves.toEqual({
      notifications: [],
      unread_count: 1
    });

    expect(dropsService.findDropsByIds).toHaveBeenCalledWith(
      ['deleted-original-drop', 'quote-drop'],
      expect.anything()
    );
  });
});
