import { UserGroupsService } from './user-groups.service';
import { membershipReaderPolicy } from '@/membership/membership-reader-policy';

jest.mock('@/membership/membership-reader-policy', () => ({
  membershipReaderPolicy: jest.fn(),
  membershipReaderCoverageRevision: jest.fn(() => null)
}));

const policy = jest.mocked(membershipReaderPolicy);
const incomplete = {
  eligible_group_ids: [],
  candidate_count: 513,
  coverage_complete: false,
  materialized_count: 0,
  direct_count: 0,
  direct_duration_ms: 0,
  shadow_duration_ms: null,
  fallback_reasons: {},
  shadow_direct_group_ids: null,
  shadow_equal: null
};

describe('UserGroupsService controlled membership read boundary', () => {
  afterEach(() => jest.clearAllMocks());

  it('falls back to bounded primary direct evaluation when scoped coverage is incomplete', async () => {
    policy.mockReturnValue({ read: true, shadow: false });
    const reader = {
      read: jest.fn().mockResolvedValue(incomplete),
      readDirect: jest.fn().mockResolvedValue(['primary-eligible'])
    };
    const service = new UserGroupsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      reader as any
    );
    const legacy = jest.spyOn(
      service as any,
      'getGroupsUserIsEligibleForLegacy'
    );
    expect(await service.getGroupsUserIsEligibleFor('profile-1')).toEqual([
      'primary-eligible'
    ]);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.readDirect).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('keeps the normal result while running a controlled shadow comparison', async () => {
    policy.mockReturnValue({ read: false, shadow: true });
    const reader = {
      read: jest.fn().mockResolvedValue({
        ...incomplete,
        coverage_complete: true,
        candidate_count: 1,
        eligible_group_ids: [],
        shadow_direct_group_ids: ['group-1'],
        shadow_equal: false
      })
    };
    const service = new UserGroupsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      reader as any
    );
    jest
      .spyOn(service as any, 'getGroupsUserIsEligibleForLegacy')
      .mockResolvedValue(['legacy-eligible']);
    expect(await service.getGroupsUserIsEligibleFor('profile-1')).toEqual([
      'legacy-eligible'
    ]);
    expect(reader.read).toHaveBeenCalledWith(
      'profile-1',
      expect.any(Function),
      expect.any(Function),
      true,
      undefined
    );
  });

  it('uses the complete primary direct result when controlled read parity fails', async () => {
    policy.mockReturnValue({ read: true, shadow: true });
    const reader = {
      read: jest.fn().mockResolvedValue({
        ...incomplete,
        coverage_complete: true,
        candidate_count: 1,
        materialized_count: 1,
        eligible_group_ids: [],
        shadow_direct_group_ids: ['group-1'],
        shadow_equal: false
      })
    };
    const service = new UserGroupsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      reader as any
    );
    expect(await service.getGroupsUserIsEligibleFor('profile-1')).toEqual([
      'group-1'
    ]);
  });

  it('uses primary direct fallback for a targeted authorization query', async () => {
    policy.mockReturnValue({ read: true, shadow: false });
    const reader = {
      read: jest.fn().mockResolvedValue(incomplete),
      readDirect: jest.fn().mockResolvedValue(['group-1'])
    };
    const service = new UserGroupsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      reader as any
    );
    const legacy = jest.spyOn(
      service as any,
      'whichOfGivenGroupsIsUserEligibleFor'
    );
    expect(
      await service.getGroupsUserIsEligibleForByIds('profile-1', ['group-1'])
    ).toEqual(['group-1']);
    expect(reader.readDirect).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('fails closed if bounded primary direct fallback cannot finish', async () => {
    policy.mockReturnValue({ read: true, shadow: false });
    const reader = {
      read: jest.fn().mockResolvedValue(incomplete),
      readDirect: jest.fn().mockRejectedValue(new Error('candidate bound'))
    };
    const service = new UserGroupsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      reader as any
    );
    const legacy = jest.spyOn(
      service as any,
      'getGroupsUserIsEligibleForLegacy'
    );
    await expect(
      service.getGroupsUserIsEligibleFor('profile-1')
    ).rejects.toMatchObject({
      status: 503
    });
    expect(legacy).not.toHaveBeenCalled();
  });
});
