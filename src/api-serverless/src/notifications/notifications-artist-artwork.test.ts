import { AuthenticationContext } from '@/auth-context';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { NotificationsApiService } from './notifications.api.service';

it.each(['v1', 'v2'])(
  'preserves artist and specific submission context through the %s notification API',
  async (version) => {
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set());
    const artist = { id: 'artist', handle: 'Bicasso', pfp: null };
    const drop = { id: 'artwork', author: artist };
    const data = {
      artist_id: artist.id,
      wave_id: 'main-stage',
      drop_id: drop.id,
      competition_id: 'competition',
      entry_id: 'entry',
      submitted_at: 123,
      artwork_title: null,
      competition_title: 'The Memes – Main Stage'
    };
    const reader = {
      getNotificationsForIdentity: jest.fn().mockResolvedValue({
        notifications: [
          {
            id: 1,
            created_at: 124,
            read_at: null,
            cause: IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED,
            data
          }
        ],
        total_unread: 1
      })
    };
    const identities = {
      getOverviewsByIds: jest.fn().mockResolvedValue({ artist }),
      getApiIdentityOverviewsByIds: jest.fn().mockResolvedValue({ artist })
    };
    const drops = {
      findDropsByIds: jest.fn().mockResolvedValue({ artwork: drop }),
      findDropsV2ByIds: jest.fn().mockResolvedValue({ artwork: drop })
    };
    const args = [
      reader,
      { getGroupsUserIsEligibleFor: async () => [] },
      identities,
      drops,
      {},
      {},
      { findWavesByIds: async () => [] },
      {},
      {},
      { mapWaves: async () => ({}) }
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
    const result =
      version === 'v1'
        ? await service.getNotifications(params, auth)
        : await service.getNotificationsV2(params, auth, {});
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({
      cause: 'ARTIST_ARTWORK_SUBMITTED',
      related_identity: artist,
      related_drops: [drop],
      additional_context: data
    });
    expect(
      version === 'v1'
        ? identities.getOverviewsByIds
        : identities.getApiIdentityOverviewsByIds
    ).toHaveBeenCalledWith(['artist'], expect.any(Object));
    expect(
      version === 'v1' ? drops.findDropsByIds : drops.findDropsV2ByIds
    ).toHaveBeenCalledWith(['artwork'], expect.any(Object));
  }
);
afterEach(() => jest.restoreAllMocks());
