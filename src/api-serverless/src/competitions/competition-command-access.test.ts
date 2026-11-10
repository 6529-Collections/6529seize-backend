import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ForbiddenException } from '@/exceptions';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { assertCompetitionGroup } from './competition-command-access';

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: { getGroupsUserIsEligibleForByIds: jest.fn() }
}));

const eligibleGroups = jest.mocked(
  userGroupsService.getGroupsUserIsEligibleForByIds
);

function proxyContext(waveAllowlist: readonly string[] | null) {
  return new AuthenticationContext({
    authenticatedWallet: '0xgrantee',
    authenticatedProfileId: 'grantee',
    roleProfileId: 'grantor',
    activeProxyActions: [
      {
        id: 'post',
        type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        credit_amount: null,
        credit_spent: null,
        wave_allowlist: waveAllowlist
      }
    ]
  });
}

describe('assertCompetitionGroup with a wave-scoped proxy grant', () => {
  beforeEach(() => {
    eligibleGroups.mockReset();
    eligibleGroups.mockResolvedValue(['participants']);
  });

  it('lets a restricted proxy submit in a listed wave when the group gate passes', async () => {
    await expect(
      assertCompetitionGroup(
        'participants',
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        { authenticationContext: proxyContext(['wave-1']) },
        'wave-1'
      )
    ).resolves.toBeUndefined();
    expect(eligibleGroups).toHaveBeenCalledWith(
      'grantor',
      ['participants'],
      undefined
    );
  });

  it('refuses a restricted proxy in a wave outside its allowlist before the group gate', async () => {
    await expect(
      assertCompetitionGroup(
        'participants',
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        { authenticationContext: proxyContext(['wave-1']) },
        'wave-2'
      )
    ).rejects.toThrow(ForbiddenException);
    expect(eligibleGroups).not.toHaveBeenCalled();
  });

  it('still applies the group gate to a restricted proxy in a listed wave', async () => {
    eligibleGroups.mockResolvedValue([]);
    await expect(
      assertCompetitionGroup(
        'participants',
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        { authenticationContext: proxyContext(['wave-1']) },
        'wave-1'
      )
    ).rejects.toThrow(ForbiddenException);
  });

  it('keeps a legacy unrestricted grant working in any wave', async () => {
    await expect(
      assertCompetitionGroup(
        null,
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        { authenticationContext: proxyContext(null) },
        'wave-anything'
      )
    ).resolves.toBeUndefined();
  });

  it('does not apply the wave scope to other actions', async () => {
    const voter = new AuthenticationContext({
      authenticatedWallet: '0xgrantee',
      authenticatedProfileId: 'grantee',
      roleProfileId: 'grantor',
      activeProxyActions: [
        {
          id: 'vote',
          type: ProfileProxyActionType.RATE_WAVE_DROP,
          credit_amount: null,
          credit_spent: null,
          wave_allowlist: null
        }
      ]
    });
    await expect(
      assertCompetitionGroup(
        null,
        ProfileProxyActionType.RATE_WAVE_DROP,
        { authenticationContext: voter },
        'wave-2'
      )
    ).resolves.toBeUndefined();
  });

  it('is unchanged for a non-proxy user', async () => {
    await expect(
      assertCompetitionGroup(
        null,
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        { authenticationContext: AuthenticationContext.fromProfileId('me') },
        'wave-2'
      )
    ).resolves.toBeUndefined();
  });
});
