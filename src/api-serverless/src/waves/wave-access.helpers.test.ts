import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import {
  getGroupsUserIsEligibleForReadContext,
  getWaveManagementContextOrThrow
} from './wave-access.helpers';

describe('getGroupsUserIsEligibleForReadContext', () => {
  it('reuses the same eligible-groups promise within a request context', async () => {
    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    };
    const getGroupsUserIsEligibleFor = jest.fn().mockResolvedValue(['group-1']);
    const userGroupsService = { getGroupsUserIsEligibleFor };

    const [first, second] = await Promise.all([
      getGroupsUserIsEligibleForReadContext(userGroupsService as any, ctx),
      getGroupsUserIsEligibleForReadContext(userGroupsService as any, ctx)
    ]);

    expect(first).toEqual(['group-1']);
    expect(second).toEqual(['group-1']);
    expect(getGroupsUserIsEligibleFor).toHaveBeenCalledTimes(1);
    expect(getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'viewer-1',
      undefined
    );
  });

  it('does not call eligibility service without a wave read profile', async () => {
    const getGroupsUserIsEligibleFor = jest.fn();

    const result = await getGroupsUserIsEligibleForReadContext(
      { getGroupsUserIsEligibleFor } as any,
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );

    expect(result).toEqual([]);
    expect(getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
  });
});

describe('getWaveManagementContextOrThrow', () => {
  it('does not validate the wave before authorization succeeds', async () => {
    const validateWave = jest.fn(() => {
      throw new Error('should not run');
    });

    await expect(
      getWaveManagementContextOrThrow({
        waveId: 'wave-1',
        ctx: {
          authenticationContext: AuthenticationContext.fromProfileId('outsider')
        } as any,
        wavesApiDb: {
          findWaveById: jest.fn().mockResolvedValue({
            id: 'wave-1',
            admin_group_id: 'admin-group',
            created_by: 'creator'
          })
        } as any,
        userGroupsService: {
          getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
        } as any,
        proxyErrorMessage: `Proxy not allowed`,
        forbiddenMessage: `Forbidden`,
        allowCreator: true,
        requireAdminGroup: false,
        validateWave
      })
    ).rejects.toThrow(ForbiddenException);

    expect(validateWave).not.toHaveBeenCalled();
  });
});
