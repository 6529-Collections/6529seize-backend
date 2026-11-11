import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import type { WavesApiDb } from '@/api/waves/waves.api.db';
import {
  getGroupsUserIsEligibleForReadContext,
  getWaveManagementContextOrThrow,
  assertWaveAndParentVisibleOrThrow,
  assertWaveAndParentVisibleToProfileOrThrow
} from './wave-access.helpers';

describe('independent subwave visibility', () => {
  it.each([
    { childGroup: null, eligible: [], allowed: false },
    { childGroup: 'child-group', eligible: ['child-group'], allowed: false },
    { childGroup: 'child-group', eligible: ['parent-group'], allowed: false },
    { childGroup: null, eligible: ['parent-group'], allowed: true },
    {
      childGroup: 'child-group',
      eligible: ['parent-group', 'child-group'],
      allowed: true
    }
  ])(
    'requires both audiences: $childGroup / $eligible',
    async ({ childGroup, eligible, allowed }) => {
      const wave = {
        visibility_group_id: childGroup,
        parent_wave_id: 'parent'
      };
      const wavesApiDb = {
        findWaveById: jest.fn().mockResolvedValue({
          visibility_group_id: 'parent-group',
          parent_wave_id: null
        })
      } as unknown as WavesApiDb;
      const access = assertWaveAndParentVisibleOrThrow({
        wave,
        groupsUserIsEligibleFor: eligible,
        message: 'Wave not found',
        wavesApiDb,
        ctx: {}
      });
      if (allowed) {
        await expect(access).resolves.toBe(wave);
      } else {
        await expect(access).rejects.toThrow(NotFoundException);
      }
    }
  );
});

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

describe('assertWaveAndParentVisibleToProfileOrThrow', () => {
  const wavesApiDb = {
    findWaveById: jest.fn().mockResolvedValue({
      visibility_group_id: 'parent-group',
      parent_wave_id: null
    })
  } as unknown as WavesApiDb;

  function userGroups(eligible: string[]) {
    return {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(eligible)
    };
  }

  it('throws not found for a missing wave without loading eligibility', async () => {
    const userGroupsService = userGroups([]);
    await expect(
      assertWaveAndParentVisibleToProfileOrThrow({
        wave: null,
        profileId: 'profile-1',
        userGroupsService,
        message: 'Wave w not found.',
        wavesApiDb,
        ctx: {}
      })
    ).rejects.toThrow(new NotFoundException('Wave w not found.'));
    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
  });

  it('accepts a public root wave without loading eligibility', async () => {
    const userGroupsService = userGroups([]);
    const wave = { visibility_group_id: null, parent_wave_id: null };
    await expect(
      assertWaveAndParentVisibleToProfileOrThrow({
        wave,
        profileId: 'profile-1',
        userGroupsService,
        message: 'not found',
        wavesApiDb,
        ctx: {}
      })
    ).resolves.toEqual({ wave, groupsUserIsEligibleFor: undefined });
    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a private wave',
      { visibility_group_id: 'group-1', parent_wave_id: null }
    ],
    [
      'a public subwave of a private parent',
      { visibility_group_id: null, parent_wave_id: 'parent' }
    ]
  ])('hides %s from a non-member', async (_label, wave) => {
    await expect(
      assertWaveAndParentVisibleToProfileOrThrow({
        wave,
        profileId: 'profile-1',
        userGroupsService: userGroups([]),
        message: 'not found',
        wavesApiDb,
        ctx: {}
      })
    ).rejects.toThrow(NotFoundException);
  });

  it('returns the loaded groups for a member', async () => {
    const wave = { visibility_group_id: 'group-1', parent_wave_id: null };
    await expect(
      assertWaveAndParentVisibleToProfileOrThrow({
        wave,
        profileId: 'profile-1',
        userGroupsService: userGroups(['group-1']),
        message: 'not found',
        wavesApiDb,
        ctx: {}
      })
    ).resolves.toEqual({ wave, groupsUserIsEligibleFor: ['group-1'] });
  });
});
