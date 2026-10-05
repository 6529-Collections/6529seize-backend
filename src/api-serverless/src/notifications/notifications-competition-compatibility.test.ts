import { AuthenticationContext } from '@/auth-context';
import { NotificationsApiService } from './notifications.api.service';

describe('notification API competition opt-in', () => {
  it('forwards opt-in in v2 but unconditionally excludes it from v1', async () => {
    const reader = {
      getNotificationsForIdentity: jest
        .fn()
        .mockResolvedValue({ notifications: [], total_unread: 0 })
    };
    const groups = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };
    const identities = {
      getOverviewsByIds: jest.fn().mockResolvedValue({}),
      getApiIdentityOverviewsByIds: jest.fn().mockResolvedValue({})
    };
    const drops = {
      findDropsByIds: jest.fn().mockResolvedValue({}),
      findDropsV2ByIds: jest.fn().mockResolvedValue({})
    };
    const waves = { findWavesByIds: jest.fn().mockResolvedValue([]) };
    const mapper = { mapWaves: jest.fn().mockResolvedValue({}) };
    const args = [
      reader,
      groups,
      identities,
      drops,
      {},
      {},
      waves,
      {},
      {},
      mapper
    ] as unknown as ConstructorParameters<typeof NotificationsApiService>;
    const service = new NotificationsApiService(...args);
    const auth = AuthenticationContext.fromProfileId('viewer');
    const request = {
      id_less_than: null,
      limit: 10,
      cause: null,
      cause_exclude: null,
      unread_only: false,
      include_competitions: true
    };
    await service.getNotificationsV2(request, auth, {});
    expect(reader.getNotificationsForIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ include_competitions: true })
    );
    await service.getNotifications(request, auth);
    expect(reader.getNotificationsForIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ include_competitions: false })
    );
  });
});
