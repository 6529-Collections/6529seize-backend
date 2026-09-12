import { ApiIdentitySubscriptionTargetAction } from '@/api/generated/models/ApiIdentitySubscriptionTargetAction';
import { IdentitiesService } from './identities.service';

describe('IdentitiesService subscriptions', () => {
  it('rejects following a profile blocked by the subscriber', async () => {
    const connection = {} as any;
    const identitiesDb = {
      getEverythingRelatedToIdentitiesByAddresses: jest.fn().mockResolvedValue({
        '0xtarget': { identity: { profile_id: 'target-profile' } }
      })
    };
    const identitySubscriptionsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (executable: (connection: any) => Promise<unknown>) =>
          executable(connection)
      ),
      findIdentitySubscriptionActionsOfTarget: jest.fn()
    };
    const contentModerationDb = {
      isProfileBlocked: jest.fn().mockResolvedValue(true)
    };
    const service = new IdentitiesService(
      identitiesDb as any,
      identitySubscriptionsDb as any,
      {} as any,
      {} as any,
      contentModerationDb as any
    );

    await expect(
      service.addIdentitySubscriptionActions({
        subscriber: 'viewer-profile',
        identityAddress: '0xtarget',
        actions: [ApiIdentitySubscriptionTargetAction.DropCreated]
      })
    ).rejects.toThrow(`You can't follow a profile you have blocked`);

    expect(contentModerationDb.isProfileBlocked).toHaveBeenCalledWith(
      'viewer-profile',
      'target-profile',
      connection
    );
    expect(
      identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget
    ).not.toHaveBeenCalled();
  });
});
