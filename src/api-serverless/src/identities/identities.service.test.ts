import { ApiIdentitySubscriptionTargetAction } from '@/api/generated/models/ApiIdentitySubscriptionTargetAction';
import { IdentitiesService } from './identities.service';
import * as membershipPolicy from '@/membership/membership-producer-policy';

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

describe('IdentitiesService membership source coverage', () => {
  const service = new IdentitiesService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

  it('refuses an identity/profile insert without a caller-owned barrier when tracking is active', async () => {
    const active = jest
      .spyOn(membershipPolicy, 'isMembershipSourceTrackingActive')
      .mockReturnValue(true);
    try {
      await expect(service.bulkCreateIdentities(['0xabc'], {})).rejects.toThrow(
        'Membership source evidence is missing'
      );
    } finally {
      active.mockRestore();
    }
  });

  it('refuses a primary-address update outside the delegation cycle', async () => {
    const active = jest
      .spyOn(membershipPolicy, 'isMembershipSourceTrackingActive')
      .mockReturnValue(true);
    try {
      await expect(
        service.updatePrimaryAddresses(new Set(['0xabc']))
      ).rejects.toThrow('Membership source evidence is missing');
    } finally {
      active.mockRestore();
    }
  });

  it('allows empty write sets without source admission', async () => {
    const active = jest
      .spyOn(membershipPolicy, 'isMembershipSourceTrackingActive')
      .mockReturnValue(true);
    try {
      await expect(service.bulkCreateIdentities([], {})).resolves.toEqual({});
      await expect(
        service.updatePrimaryAddresses(new Set())
      ).resolves.toBeUndefined();
    } finally {
      active.mockRestore();
    }
  });
});
