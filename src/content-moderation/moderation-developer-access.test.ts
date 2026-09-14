import { AuthenticationContext } from '@/auth-context';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import {
  assertModerationDeveloper,
  isModerationDeveloper,
  MODERATION_DEVELOPER_GROUP_ID
} from './moderation-developer-access';

const mockEligibility = jest.fn();
jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: { getGroupsUserIsEligibleForByIds: mockEligibility }
}));

const memberContext = () => ({
  authenticationContext: AuthenticationContext.fromProfileId('member')
});

describe('moderation saved-group authorization', () => {
  beforeEach(() => {
    mockEligibility.mockReset().mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('authorizes the authenticated identity through the exact saved group', async () => {
    mockEligibility.mockResolvedValue([MODERATION_DEVELOPER_GROUP_ID]);
    const ctx = memberContext();
    await expect(assertModerationDeveloper(ctx)).resolves.toBe('member');
    expect(mockEligibility).toHaveBeenCalledWith(
      'member',
      [MODERATION_DEVELOPER_GROUP_ID],
      undefined
    );
  });

  it.each([{ groups: [] }, { groups: ['an-unrelated-group'] }])(
    'denies identities outside the canonical group (%j)',
    async ({ groups }) => {
      mockEligibility.mockResolvedValue(groups);
      await expect(
        assertModerationDeveloper(memberContext())
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  );

  it.each([
    {},
    { authenticationContext: AuthenticationContext.notAuthenticated() },
    {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'delegate',
        roleProfileId: 'member',
        activeProxyActions: []
      })
    }
  ])(
    'rejects missing authentication and proxies before membership reads',
    async (ctx) => {
      await expect(isModerationDeveloper('member', ctx)).resolves.toBe(false);
      await expect(assertModerationDeveloper(ctx)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(mockEligibility).not.toHaveBeenCalled();
    }
  );

  it('rejects a caller-supplied identity different from the authenticated actor', async () => {
    mockEligibility.mockResolvedValue([MODERATION_DEVELOPER_GROUP_ID]);
    await expect(
      isModerationDeveloper('other-member', memberContext())
    ).resolves.toBe(false);
    expect(mockEligibility).not.toHaveBeenCalled();
  });

  it('rechecks membership after revocation instead of retaining a positive result', async () => {
    mockEligibility
      .mockResolvedValueOnce([MODERATION_DEVELOPER_GROUP_ID])
      .mockResolvedValueOnce([]);
    await expect(assertModerationDeveloper(memberContext())).resolves.toBe(
      'member'
    );
    await expect(
      assertModerationDeveloper(memberContext())
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockEligibility).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a retryable sanitized error when eligibility cannot be read', async () => {
    const report = jest
      .spyOn(Logger.get('ModerationDeveloperAccess'), 'error')
      .mockImplementation();
    mockEligibility.mockRejectedValue(new Error('private database context'));
    const error = await assertModerationDeveloper(memberContext()).catch(
      (cause) => cause
    );
    expect(error).toBeInstanceOf(CustomApiCompliantException);
    expect(error.getStatusCode()).toBe(503);
    expect(error.code).toBe('MODERATION_ACCESS_UNAVAILABLE');
    expect(error.message).not.toContain('private database context');
    expect(report).toHaveBeenCalledWith(
      'Unable to verify moderation developer group eligibility'
    );
  });
});
