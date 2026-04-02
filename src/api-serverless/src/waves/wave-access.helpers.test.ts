import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { getWaveManagementContextOrThrow } from './wave-access.helpers';

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
