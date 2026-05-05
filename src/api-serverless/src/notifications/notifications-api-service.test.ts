import { AuthenticationContext } from '@/auth-context';
import { ApiDropGroupMention } from '@/api/generated/models/ApiDropGroupMention';
import { ApiNotificationCause } from '@/api/generated/models/ApiNotificationCause';
import { NotificationsApiService } from '@/api/notifications/notifications.api.service';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';

describe('NotificationsApiService V2 notifications', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeIdentity(id: string, handle: string, pfp: string) {
    return {
      id,
      handle,
      pfp,
      primary_address: `0x${id}`,
      level: 1,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 0,
        artist_of_memes: 0
      }
    };
  }

  function createService() {
    const notificationsReader = {
      getNotificationsForIdentity: jest.fn().mockResolvedValue({
        notifications: [],
        total_unread: 0
      })
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['group-1'])
    };
    const identityFetcher = {
      getApiIdentityOverviewsByIds: jest.fn().mockResolvedValue({})
    };
    const dropsService = {
      findDropsV2ByIds: jest.fn().mockResolvedValue({})
    };
    const wavesApiDb = {
      findWavesByIds: jest.fn().mockResolvedValue([])
    };
    const apiWaveOverviewMapper = {
      mapWaves: jest.fn().mockResolvedValue({})
    };
    const reactionsDb = {
      getReactionProfilesByDropId: jest.fn().mockResolvedValue([])
    };
    const service = new NotificationsApiService(
      notificationsReader as any,
      userGroupsService as any,
      identityFetcher as any,
      dropsService as any,
      {} as any,
      {} as any,
      wavesApiDb as any,
      {} as any,
      reactionsDb as any,
      apiWaveOverviewMapper as any
    );
    return {
      service,
      notificationsReader,
      userGroupsService,
      identityFetcher,
      dropsService,
      wavesApiDb,
      apiWaveOverviewMapper,
      reactionsDb
    };
  }

  it('maps V2 notifications with ApiIdentityOverview and ApiDropV2', async () => {
    const { service, notificationsReader, identityFetcher, dropsService } =
      createService();
    const subscriber = makeIdentity(
      'subscriber-profile-1',
      'alice',
      'alice.png'
    );
    notificationsReader.getNotificationsForIdentity.mockResolvedValue({
      notifications: [
        {
          id: 1,
          created_at: 1000,
          read_at: null,
          cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
          data: {
            subscriber_id: 'subscriber-profile-1',
            subscribed_to: 'viewer-1'
          }
        }
      ],
      total_unread: 2
    });
    identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'subscriber-profile-1': subscriber
    });

    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const result = await service.getNotificationsV2(
      {
        id_less_than: null,
        limit: 10,
        cause: null,
        cause_exclude: null,
        unread_only: false
      },
      authenticationContext,
      { authenticationContext }
    );

    expect(dropsService.findDropsV2ByIds).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ authenticationContext })
    );
    expect(identityFetcher.getApiIdentityOverviewsByIds).toHaveBeenCalledWith(
      ['subscriber-profile-1'],
      expect.objectContaining({ authenticationContext })
    );
    expect(result).toEqual({
      notifications: [
        {
          id: 1,
          created_at: 1000,
          read_at: null,
          cause: ApiNotificationCause.IdentitySubscribed,
          related_identity: subscriber,
          related_drops: [],
          additional_context: {}
        }
      ],
      unread_count: 2
    });
  });

  it('adds related wave overview to V2 notifications with a wave id', async () => {
    const {
      service,
      notificationsReader,
      identityFetcher,
      wavesApiDb,
      apiWaveOverviewMapper
    } = createService();
    const creator = makeIdentity('creator-1', 'creator', 'creator.png');
    const waveEntity = { id: 'wave-1' };
    const waveOverview = {
      id: 'wave-1',
      name: 'Wave 1',
      last_drop_time: 3000,
      created_at: 1000,
      subscribers_count: 12,
      has_competition: false,
      is_dm_wave: false,
      description_drop: {},
      total_drops_count: 3,
      is_private: false
    };
    notificationsReader.getNotificationsForIdentity.mockResolvedValue({
      notifications: [
        {
          id: 3,
          created_at: 5000,
          read_at: null,
          cause: IdentityNotificationCause.WAVE_CREATED,
          data: {
            wave_id: 'wave-1',
            created_by: 'creator-1'
          }
        }
      ],
      total_unread: 1
    });
    identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'creator-1': creator
    });
    wavesApiDb.findWavesByIds.mockResolvedValue([waveEntity]);
    apiWaveOverviewMapper.mapWaves.mockResolvedValue({
      'wave-1': waveOverview
    });

    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const result = await service.getNotificationsV2(
      {
        id_less_than: null,
        limit: 10,
        cause: null,
        cause_exclude: null,
        unread_only: false
      },
      authenticationContext,
      { authenticationContext }
    );

    expect(wavesApiDb.findWavesByIds).toHaveBeenCalledWith(
      ['wave-1'],
      ['group-1'],
      undefined
    );
    expect(apiWaveOverviewMapper.mapWaves).toHaveBeenCalledWith(
      [waveEntity],
      expect.objectContaining({ authenticationContext })
    );
    expect(result).toEqual({
      notifications: [
        {
          id: 3,
          created_at: 5000,
          read_at: null,
          cause: ApiNotificationCause.WaveCreated,
          related_identity: creator,
          related_drops: [],
          related_wave: waveOverview,
          additional_context: {
            wave_id: 'wave-1'
          }
        }
      ],
      unread_count: 1
    });
  });

  it('adds matching reactors to DROP_REACTED additional context', async () => {
    const {
      service,
      notificationsReader,
      identityFetcher,
      dropsService,
      reactionsDb
    } = createService();
    const drop = { id: 'drop-1', content: 'v2 drop' };
    const reactorOne = makeIdentity('reactor-1', 'alice', 'alice.png');
    const reactorTwo = makeIdentity('reactor-2', 'bob', 'bob.png');
    const reactorForOtherReaction = makeIdentity(
      'reactor-3',
      'carol',
      'carol.png'
    );
    notificationsReader.getNotificationsForIdentity.mockResolvedValue({
      notifications: [
        {
          id: 7,
          created_at: 2000,
          read_at: null,
          cause: IdentityNotificationCause.DROP_REACTED,
          data: {
            profile_id: 'reactor-1',
            drop_id: 'drop-1',
            drop_author_id: 'author-1',
            reaction: 'LIKE',
            wave_id: 'wave-1'
          }
        }
      ],
      total_unread: 5
    });
    dropsService.findDropsV2ByIds.mockResolvedValue({
      'drop-1': drop
    });
    reactionsDb.getReactionProfilesByDropId.mockResolvedValue([
      { reaction: 'LIKE', profile_id: 'reactor-1' },
      { reaction: 'LIKE', profile_id: 'reactor-2' },
      { reaction: 'LOVE', profile_id: 'reactor-3' }
    ]);
    identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'reactor-1': reactorOne,
      'reactor-2': reactorTwo,
      'reactor-3': reactorForOtherReaction
    });

    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const result = await service.getNotificationsV2(
      {
        id_less_than: null,
        limit: 10,
        cause: null,
        cause_exclude: null,
        unread_only: false
      },
      authenticationContext,
      { authenticationContext }
    );

    expect(reactionsDb.getReactionProfilesByDropId).toHaveBeenCalledWith(
      'drop-1',
      expect.objectContaining({ authenticationContext })
    );
    expect(dropsService.findDropsV2ByIds).toHaveBeenCalledWith(
      ['drop-1'],
      expect.objectContaining({ authenticationContext })
    );
    expect(identityFetcher.getApiIdentityOverviewsByIds).toHaveBeenCalledWith(
      ['reactor-1', 'reactor-2', 'reactor-3'],
      expect.objectContaining({ authenticationContext })
    );
    expect(result).toEqual({
      notifications: [
        {
          id: 7,
          created_at: 2000,
          read_at: null,
          cause: ApiNotificationCause.DropReacted,
          related_identity: reactorOne,
          related_drops: [drop],
          additional_context: {
            reaction: 'LIKE',
            reactors: [
              { handle: 'alice', pfp: 'alice.png' },
              { handle: 'bob', pfp: 'bob.png' }
            ]
          }
        }
      ],
      unread_count: 5
    });
    const reactors = result.notifications[0].additional_context.reactors ?? [];
    expect(reactors).toHaveLength(2);
    expect(Object.keys(reactors[0])).toEqual(['handle', 'pfp']);
  });

  it('skips V2 notifications when a related drop is missing', async () => {
    const { service, notificationsReader, identityFetcher, dropsService } =
      createService();
    const subscriber = makeIdentity(
      'subscriber-profile-1',
      'alice',
      'alice.png'
    );
    const reactor = makeIdentity('reactor-1', 'bob', 'bob.png');
    notificationsReader.getNotificationsForIdentity.mockResolvedValue({
      notifications: [
        {
          id: 11,
          created_at: 3000,
          read_at: null,
          cause: IdentityNotificationCause.DROP_REACTED,
          data: {
            profile_id: 'reactor-1',
            drop_id: 'missing-drop',
            drop_author_id: 'author-1',
            reaction: 'LIKE',
            wave_id: 'wave-1'
          }
        },
        {
          id: 12,
          created_at: 4000,
          read_at: null,
          cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
          data: {
            subscriber_id: 'subscriber-profile-1',
            subscribed_to: 'viewer-1'
          }
        }
      ],
      total_unread: 2
    });
    dropsService.findDropsV2ByIds.mockResolvedValue({});
    identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'reactor-1': reactor,
      'subscriber-profile-1': subscriber
    });

    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const result = await service.getNotificationsV2(
      {
        id_less_than: null,
        limit: 10,
        cause: null,
        cause_exclude: null,
        unread_only: false
      },
      authenticationContext,
      { authenticationContext }
    );

    expect(dropsService.findDropsV2ByIds).toHaveBeenCalledWith(
      ['missing-drop'],
      expect.objectContaining({ authenticationContext })
    );
    expect(result).toEqual({
      notifications: [
        {
          id: 12,
          created_at: 4000,
          read_at: null,
          cause: ApiNotificationCause.IdentitySubscribed,
          related_identity: subscriber,
          related_drops: [],
          additional_context: {}
        }
      ],
      unread_count: 2
    });
  });
});

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
