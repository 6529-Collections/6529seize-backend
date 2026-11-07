import { mock } from 'ts-jest-mocker';
import { IdentitySubscriptionsApiService } from './identity-subscriptions.api.service';
import { IdentitySubscriptionsDb } from './identity-subscriptions.db';
import { WaveFollowerEligibilityService } from './wave-follower-eligibility';
import { WaveApiService } from '@/api/waves/wave.api.service';
import { DropsApiService } from '@/api/drops/drops.api.service';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';

describe('Incoming subscriptions API', () => {
  const subscriptions = mock<IdentitySubscriptionsDb>();
  const identities = mock<IdentityFetcher>();
  const eligibility = mock<WaveFollowerEligibilityService>();
  const service = new IdentitySubscriptionsApiService(
    subscriptions,
    mock<WaveApiService>(),
    mock<DropsApiService>(),
    identities,
    mock<UserGroupsService>(),
    eligibility
  );
  const membership = [
    { key: 'readers', sql: 'with user_groups_view as (select 1)', params: {} }
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    subscriptions.findSubscriberIdsAndActionsForTarget.mockResolvedValue({
      alice: [ActivityEventAction.DROP_CREATED]
    });
    subscriptions.countDistinctSubscriberIdsForTarget.mockResolvedValue(2);
    identities.getOverviewsByIds.mockResolvedValue({
      alice: Object.assign(new ApiProfileMin(), { id: 'alice', level: 1 })
    });
    eligibility.resolve.mockResolvedValue(membership);
  });

  it.each([
    [1, true],
    [2, false]
  ])('uses the eligible count for page %s and next=%s', async (page, next) => {
    const params = {
      target_id: 'wave',
      target_type: ActivityEventTargetType.WAVE,
      page,
      page_size: 1
    };
    const ctx = { timer: undefined };
    const result = await service.findIncomingSubscriptionsOfType(params, ctx);
    expect(result).toMatchObject({ page, count: 2, next });
    expect(result.data.map((item) => item.identity.id)).toEqual(['alice']);
    expect(
      subscriptions.findSubscriberIdsAndActionsForTarget
    ).toHaveBeenCalledWith(params, membership, ctx);
    expect(
      subscriptions.countDistinctSubscriberIdsForTarget
    ).toHaveBeenCalledWith(params, membership, ctx);
  });

  it.each([ActivityEventTargetType.IDENTITY, ActivityEventTargetType.DROP])(
    'preserves %s followers without applying wave eligibility',
    async (target_type) => {
      const params = {
        target_id: 'target',
        target_type,
        page: 1,
        page_size: 100
      };
      await service.findIncomingSubscriptionsOfType(params);
      expect(eligibility.resolve).not.toHaveBeenCalled();
      expect(
        subscriptions.findSubscriberIdsAndActionsForTarget
      ).toHaveBeenCalledWith(params, [], {});
    }
  );
});
