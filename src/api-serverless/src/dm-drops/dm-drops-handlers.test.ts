const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();
const mockFindDmUnreadConversationStates = jest.fn();
const mockGetGroupsUserIsEligibleForReadContext = jest.fn();
const mockUserGroupsService = { marker: 'user-groups-service' };

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: mockUserGroupsService
}));

jest.mock('@/api/waves/wave-access.helpers', () => ({
  getGroupsUserIsEligibleForReadContext:
    mockGetGroupsUserIsEligibleForReadContext
}));

jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: {
    findDmUnreadConversationStates: mockFindDmUnreadConversationStates
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDmDropsUnread } from './dm-drops.handlers';

describe('handleGetDmDropsUnread', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = {
    getActingAsId: jest.fn()
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    authenticationContext.getActingAsId.mockReturnValue('profile-1');
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
    mockGetGroupsUserIsEligibleForReadContext.mockResolvedValue(['group-1']);
    mockFindDmUnreadConversationStates.mockResolvedValue([
      {
        profile_id: 'profile-1',
        wave_id: 'wave-1',
        unread_count: 4,
        first_unread_drop_serial_no: 10,
        latest_drop_serial_no: 13,
        latest_read_serial_no: 9,
        version: 3
      },
      {
        profile_id: 'profile-1',
        wave_id: 'wave-2',
        unread_count: 3,
        first_unread_drop_serial_no: 20,
        latest_drop_serial_no: 22,
        latest_read_serial_no: 19,
        version: 5
      }
    ]);
  });

  it('returns the authenticated profile conversation snapshot and aggregate count', async () => {
    const req = { query: {} } as any;

    await expect(handleGetDmDropsUnread(req)).resolves.toEqual({
      profile_id: 'profile-1',
      count: 7,
      conversations: [
        expect.objectContaining({ wave_id: 'wave-1', unread_count: 4 }),
        expect.objectContaining({ wave_id: 'wave-2', unread_count: 3 })
      ]
    });

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockGetGroupsUserIsEligibleForReadContext).toHaveBeenCalledWith(
      mockUserGroupsService,
      { timer, authenticationContext }
    );
    expect(mockFindDmUnreadConversationStates).toHaveBeenCalledWith(
      { identityId: 'profile-1', eligibleGroups: ['group-1'] },
      { timer, authenticationContext }
    );
  });

  it('rejects unexpected query parameters', async () => {
    const req = { query: { limit: '1' } } as any;

    await expect(handleGetDmDropsUnread(req)).rejects.toThrow(
      '"limit" is not allowed'
    );
    expect(mockGetAuthenticationContext).not.toHaveBeenCalled();
    expect(mockGetGroupsUserIsEligibleForReadContext).not.toHaveBeenCalled();
    expect(mockFindDmUnreadConversationStates).not.toHaveBeenCalled();
  });

  it('rejects users without a profile', async () => {
    authenticationContext.getActingAsId.mockReturnValue(null);
    const req = { query: {} } as any;

    await expect(handleGetDmDropsUnread(req)).rejects.toThrow(
      'You need to create a profile before you can access direct messages'
    );
    expect(mockGetGroupsUserIsEligibleForReadContext).not.toHaveBeenCalled();
    expect(mockFindDmUnreadConversationStates).not.toHaveBeenCalled();
  });
});
