import { AuthenticationContext } from '@/auth-context';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { identitiesDb } from '@/identities/identities.db';
import { ProfileActivityLogsApiService } from './profile-activity-logs-api.service';

function createService() {
  const profileActivityLogsDb = {
    searchLogs: jest.fn().mockResolvedValue([])
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['viewer-group'])
  };
  const service = new ProfileActivityLogsApiService(
    profileActivityLogsDb as any,
    {} as any,
    userGroupsService as any
  );
  return { service, profileActivityLogsDb, userGroupsService };
}

function proxyContext(
  actions: ProfileProxyActionType[]
): AuthenticationContext {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: 'granting-profile',
    activeProxyActions: actions.map((type) => ({
      id: `${type}-id`,
      type,
      credit_amount: null,
      credit_spent: null
    }))
  });
}

describe('ProfileActivityLogsApiService wave read context', () => {
  beforeEach(() => {
    jest.spyOn(identitiesDb, 'getProfileHandlesByIds').mockResolvedValue({});
  });

  afterEach(() => jest.restoreAllMocks());

  async function searchWith(authenticationContext: AuthenticationContext) {
    const { service, profileActivityLogsDb, userGroupsService } =
      createService();
    await service.getProfileActivityLogsFiltered(
      {
        profileId: 'profile-1',
        logType: [ProfileActivityLogType.DROP_CREATED],
        includeProfileIdToIncoming: false,
        pageRequest: { page: 1, page_size: 10 },
        order: 'desc',
        group_id: null
      },
      { authenticationContext }
    );
    return {
      viewerGroups:
        profileActivityLogsDb.searchLogs.mock.calls[0][0]
          .viewer_eligible_group_ids,
      userGroupsService
    };
  }

  it('searches anonymous requests with no viewer groups', async () => {
    const { viewerGroups, userGroupsService } = await searchWith(
      AuthenticationContext.notAuthenticated()
    );

    expect(viewerGroups).toEqual([]);
    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
  });

  it("searches authenticated requests with the viewer's groups", async () => {
    const { viewerGroups, userGroupsService } = await searchWith(
      AuthenticationContext.fromProfileId('viewer-profile')
    );

    expect(viewerGroups).toEqual(['viewer-group']);
    expect(userGroupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'viewer-profile',
      undefined
    );
  });

  it('searches proxy requests without the read waves action as anonymous', async () => {
    const { viewerGroups } = await searchWith(
      proxyContext([ProfileProxyActionType.CREATE_DROP_TO_WAVE])
    );

    expect(viewerGroups).toEqual([]);
  });

  it('searches proxy requests with the read waves action as the granting profile', async () => {
    const { viewerGroups, userGroupsService } = await searchWith(
      proxyContext([ProfileProxyActionType.READ_WAVE])
    );

    expect(viewerGroups).toEqual(['viewer-group']);
    expect(userGroupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'granting-profile',
      undefined
    );
  });
});
