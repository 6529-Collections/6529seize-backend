import { mock } from 'ts-jest-mocker';
import { WaveFollowerEligibilityService } from './wave-follower-eligibility';
import { IdentitySubscriptionsDb } from './identity-subscriptions.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';

describe('WaveFollowerEligibilityService', () => {
  const subscriptions = mock<IdentitySubscriptionsDb>();
  const groups = mock<UserGroupsService>();
  const service = new WaveFollowerEligibilityService(subscriptions, groups);

  beforeEach(() => jest.resetAllMocks());

  it('keeps public waves on the subscription fast path', async () => {
    subscriptions.findWaveFollowerReadGroups.mockResolvedValue([]);
    await expect(service.resolve('wave', {})).resolves.toEqual([]);
    expect(
      groups.getSqlAndParamsByGroupIdForSystemBroadcast
    ).not.toHaveBeenCalled();
  });

  it('fails closed for missing waves or groups', async () => {
    subscriptions.findWaveFollowerReadGroups.mockResolvedValue(null);
    await expect(service.resolve('missing', {})).resolves.toBeNull();
    subscriptions.findWaveFollowerReadGroups.mockResolvedValue(['missing']);
    groups.getSqlAndParamsByGroupIdForSystemBroadcast.mockResolvedValue(null);
    await expect(service.resolve('wave', {})).resolves.toBeNull();
  });

  it('builds each access group once and forwards the request context', async () => {
    subscriptions.findWaveFollowerReadGroups.mockResolvedValue([
      'child',
      'parent'
    ]);
    const membership = {
      sql: 'with user_groups_view as (select 1)',
      params: {}
    };
    groups.getSqlAndParamsByGroupIdForSystemBroadcast.mockResolvedValue(
      membership
    );
    const ctx = { timer: undefined };
    await expect(service.resolve('wave', ctx)).resolves.toEqual([
      { key: 'child', ...membership },
      { key: 'parent', ...membership }
    ]);
    expect(
      groups.getSqlAndParamsByGroupIdForSystemBroadcast
    ).toHaveBeenCalledTimes(2);
    expect(
      groups.getSqlAndParamsByGroupIdForSystemBroadcast
    ).toHaveBeenCalledWith('parent', ctx);
  });
});
