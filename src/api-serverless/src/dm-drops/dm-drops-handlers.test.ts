const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();
const mockCountIdentityUnreadDmDrops = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: {
    countIdentityUnreadDmDrops: mockCountIdentityUnreadDmDrops
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
    mockCountIdentityUnreadDmDrops.mockResolvedValue(7);
  });

  it('returns the authenticated profile unread DM drop count', async () => {
    const req = { query: {} } as any;

    await expect(handleGetDmDropsUnread(req)).resolves.toEqual({ count: 7 });

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockCountIdentityUnreadDmDrops).toHaveBeenCalledWith(
      { identityId: 'profile-1' },
      { timer, authenticationContext }
    );
  });

  it('rejects unexpected query parameters', async () => {
    const req = { query: { limit: '1' } } as any;

    await expect(handleGetDmDropsUnread(req)).rejects.toThrow(
      '"limit" is not allowed'
    );
    expect(mockCountIdentityUnreadDmDrops).not.toHaveBeenCalled();
  });

  it('rejects users without a profile', async () => {
    authenticationContext.getActingAsId.mockReturnValue(null);
    const req = { query: {} } as any;

    await expect(handleGetDmDropsUnread(req)).rejects.toThrow(
      'You need to create a profile before you can access direct messages'
    );
    expect(mockCountIdentityUnreadDmDrops).not.toHaveBeenCalled();
  });
});
