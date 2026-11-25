import {
  isFrozenProxyActionType,
  ProfileProxyApiService
} from './proxy.api.service';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';
import { AcceptActionRequestActionEnum } from '../generated/models/AcceptActionRequest';

jest.mock('@/profileActivityLogs/profile-activity-logs.db', () => ({
  profileActivityLogsDb: { insert: jest.fn() }
}));

const FLAG = 'FEATURE_IDENTITY_FROZEN';
const CREATOR = 'creator-profile-id';

function setup(actionType: ProfileProxyActionType) {
  const action = {
    id: 'action-1',
    proxy_id: 'proxy-1',
    action_type: actionType,
    credit_amount: 10,
    credit_spent: 0
  };
  const profileProxiesDb = {
    findProfileProxyActionsByProxyIdAndActionType: jest
      .fn()
      .mockResolvedValue([action]),
    findProfileProxyActionById: jest.fn().mockResolvedValue(action),
    findProfileProxyById: jest.fn().mockResolvedValue({
      id: 'proxy-1',
      created_by: CREATOR,
      target_id: 'target-profile-id'
    }),
    findProfileProxyActionsByProxyId: jest.fn().mockResolvedValue([action]),
    executeNativeQueriesInTransaction: jest.fn()
  };
  const mapper = {
    profileProxyEntitiesToApiProfileProxies: jest.fn().mockResolvedValue([
      {
        id: 'proxy-1',
        created_by: { id: CREATOR },
        granted_to: { id: 'target-profile-id' },
        actions: [action]
      }
    ])
  };
  const service = new ProfileProxyApiService(
    {} as any,
    profileProxiesDb as any,
    mapper as any
  );
  return { service, profileProxiesDb };
}

describe('proxy actions during the identity freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('freezes only REP and NIC allocations', () => {
    expect(
      Object.values(ProfileProxyActionType).filter(isFrozenProxyActionType)
    ).toEqual([
      ProfileProxyActionType.ALLOCATE_REP,
      ProfileProxyActionType.ALLOCATE_CIC
    ]);
  });

  it.each([
    [
      ApiProfileProxyActionType.AllocateRep,
      ProfileProxyActionType.ALLOCATE_REP
    ],
    [ApiProfileProxyActionType.AllocateCic, ProfileProxyActionType.ALLOCATE_CIC]
  ])(
    'refuses a new %s allocation before reading anything',
    async (apiType, type) => {
      process.env[FLAG] = 'true';
      const { service, profileProxiesDb } = setup(type);
      await expect(
        service.createProfileProxyAction({
          proxy: { id: 'proxy-1' } as any,
          action: { action_type: apiType, credit_amount: 10 } as any
        })
      ).rejects.toBeInstanceOf(IdentityFrozenException);
      expect(
        profileProxiesDb.findProfileProxyActionsByProxyIdAndActionType
      ).not.toHaveBeenCalled();
    }
  );

  it('lets a new wave proxy action through to its own checks', async () => {
    process.env[FLAG] = 'true';
    const { service } = setup(ProfileProxyActionType.CREATE_DROP_TO_WAVE);
    // The mocked proxy already has this action, so the service's own
    // duplicate check answers, not the freeze.
    await expect(
      service.createProfileProxyAction({
        proxy: { id: 'proxy-1' } as any,
        action: {
          action_type: ApiProfileProxyActionType.CreateDropToWave
        } as any
      })
    ).rejects.toThrow('Action already exists');
  });

  it.each(Object.values(AcceptActionRequestActionEnum))(
    'refuses to %s a REP allocation',
    async (acceptance) => {
      process.env[FLAG] = 'true';
      const { service, profileProxiesDb } = setup(
        ProfileProxyActionType.ALLOCATE_REP
      );
      await expect(
        service.changeProfileProxyActionStatus({
          proxy_id: 'proxy-1',
          action_id: 'action-1',
          acceptance_type: acceptance,
          profile_id: CREATOR
        })
      ).rejects.toBeInstanceOf(IdentityFrozenException);
      expect(
        profileProxiesDb.executeNativeQueriesInTransaction
      ).not.toHaveBeenCalled();
    }
  );

  it('refuses to change the credit of a NIC allocation', async () => {
    process.env[FLAG] = 'true';
    const { service, profileProxiesDb } = setup(
      ProfileProxyActionType.ALLOCATE_CIC
    );
    await expect(
      service.updateProfileProxyAction({
        proxy_id: 'proxy-1',
        action_id: 'action-1',
        profile_id: CREATOR,
        credit_amount: 20
      })
    ).rejects.toBeInstanceOf(IdentityFrozenException);
    expect(
      profileProxiesDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });

  it('lets a REP allocation through to its own checks when not frozen', async () => {
    delete process.env[FLAG];
    const { service } = setup(ProfileProxyActionType.ALLOCATE_REP);
    await expect(
      service.createProfileProxyAction({
        proxy: { id: 'proxy-1' } as any,
        action: {
          action_type: ApiProfileProxyActionType.AllocateRep,
          credit_amount: 10
        } as any
      })
    ).rejects.toThrow('Action already exists');
  });
});
