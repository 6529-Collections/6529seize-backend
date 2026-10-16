import { AuthenticationContext } from '@/auth-context';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { NotificationsApiService } from './notifications.api.service';

it.each(['v1', 'v2'])(
  'hydrates collaboration actors and saved artwork names in %s, including legacy fallbacks',
  async (version) => {
    const actor = {
      id: 'actor',
      handle: 'phoebeum',
      pfp: 'https://example.com/actor.png'
    };
    const reader = { getNotificationsForIdentity: jest.fn() };
    const identities = {
      getOverviewsByIds: jest.fn().mockResolvedValue({ actor }),
      getApiIdentityOverviewsByIds: jest.fn().mockResolvedValue({ actor })
    };
    const drops = {
      findDropsByIds: jest.fn().mockResolvedValue({}),
      findDropsV2ByIds: jest.fn().mockResolvedValue({})
    };
    const args = [
      reader,
      { getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]) },
      identities,
      drops,
      {},
      {},
      { findWavesByIds: jest.fn().mockResolvedValue([]) },
      {},
      {},
      { mapWaves: jest.fn().mockResolvedValue({}) }
    ] as unknown as ConstructorParameters<typeof NotificationsApiService>;
    const service = new NotificationsApiService(...args);
    const auth = AuthenticationContext.fromProfileId('viewer');
    const params = {
      id_less_than: null,
      limit: 10,
      cause: null,
      cause_exclude: null,
      unread_only: false
    };
    const fetch = () =>
      version === 'v1'
        ? service.getNotifications(params, auth)
        : service.getNotificationsV2(params, auth, {});
    for (const event_type of ['INVITED', 'ACCEPTED']) {
      reader.getNotificationsForIdentity.mockResolvedValue({
        notifications: [
          {
            id: 1,
            created_at: 1,
            read_at: null,
            cause: IdentityNotificationCause.MEME_COLLABORATION,
            data: {
              event_type,
              actor_id: 'actor',
              artwork_name: 'Test Cat',
              wave_id: 'wave',
              drop_id: 'drop',
              invitation_id: 'invite'
            }
          }
        ],
        total_unread: 1
      });
      const result = await fetch();
      expect(result.notifications[0]).toMatchObject({
        related_identity: actor,
        related_drops: [],
        additional_context: { event_type, artwork_name: 'Test Cat' }
      });
      expect(
        version === 'v1'
          ? identities.getOverviewsByIds
          : identities.getApiIdentityOverviewsByIds
      ).toHaveBeenCalledWith(['actor'], expect.any(Object));
    }
    identities.getOverviewsByIds.mockResolvedValue({});
    identities.getApiIdentityOverviewsByIds.mockResolvedValue({});
    reader.getNotificationsForIdentity.mockResolvedValue({
      notifications: [
        {
          id: 2,
          created_at: 1,
          read_at: null,
          cause: IdentityNotificationCause.MEME_COLLABORATION,
          data: {
            event_type: 'INVITED',
            actor_id: 'deleted',
            wave_id: 'wave',
            drop_id: 'drop',
            invitation_id: 'invite'
          }
        }
      ],
      total_unread: 1
    });
    const legacy = (await fetch()).notifications[0];
    expect(legacy.related_identity).toBeNull();
    expect(legacy.additional_context).not.toHaveProperty('artwork_name');
  }
);
