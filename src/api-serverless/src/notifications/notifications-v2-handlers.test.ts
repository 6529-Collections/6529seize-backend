const mockGetNotificationsV2 = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/notifications/notifications.api.service', () => ({
  notificationsApiService: {
    getNotificationsV2: mockGetNotificationsV2
  }
}));

jest.mock('@/time', () => ({
  Time: {
    minutes: jest.fn(() => ({
      toMillis: jest.fn(() => 60000)
    }))
  },
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { handleGetNotificationsV2 } from './notifications-v2.handlers';

describe('handleGetNotificationsV2', () => {
  const timer = { marker: 'timer' } as any;
  const result = { notifications: [], unread_count: 0 } as any;
  const authenticationContext = {
    getActingAsId: jest.fn(),
    isAuthenticatedAsProxy: jest.fn()
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    authenticationContext.getActingAsId.mockReturnValue('profile-1');
    authenticationContext.isAuthenticatedAsProxy.mockReturnValue(false);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetNotificationsV2.mockResolvedValue(result);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { query: {} } as any;

    await expect(handleGetNotificationsV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockGetNotificationsV2).toHaveBeenCalledWith(
      {
        id_less_than: null,
        limit: 10,
        cause: null,
        cause_exclude: null,
        unread_only: false
      },
      authenticationContext,
      {
        timer,
        authenticationContext
      }
    );
  });

  it('normalizes query params before calling the service', async () => {
    const req = {
      query: {
        id_less_than: '123',
        limit: '25',
        cause: ` ${IdentityNotificationCause.DROP_REPLIED},${IdentityNotificationCause.DROP_VOTED} `,
        cause_exclude: IdentityNotificationCause.DROP_BOOSTED,
        unread_only: 'true'
      }
    } as any;

    await handleGetNotificationsV2(req);

    expect(mockGetNotificationsV2).toHaveBeenCalledWith(
      {
        id_less_than: 123,
        limit: 25,
        cause: `${IdentityNotificationCause.DROP_REPLIED},${IdentityNotificationCause.DROP_VOTED}`,
        cause_exclude: IdentityNotificationCause.DROP_BOOSTED,
        unread_only: true
      },
      authenticationContext,
      {
        timer,
        authenticationContext
      }
    );
  });

  it('rejects invalid notification causes', async () => {
    const req = { query: { cause: 'NOT_A_CAUSE' } } as any;

    await expect(handleGetNotificationsV2(req)).rejects.toThrow(
      '"cause" contains an invalid value'
    );
    expect(mockGetNotificationsV2).not.toHaveBeenCalled();
  });

  it('rejects users without a profile', async () => {
    authenticationContext.getActingAsId.mockReturnValue(null);
    const req = { query: {} } as any;

    await expect(handleGetNotificationsV2(req)).rejects.toThrow(
      'You need to create a profile before you can access notifications'
    );
    expect(mockGetNotificationsV2).not.toHaveBeenCalled();
  });

  it('rejects proxy-authenticated users', async () => {
    authenticationContext.isAuthenticatedAsProxy.mockReturnValue(true);
    const req = { query: {} } as any;

    await expect(handleGetNotificationsV2(req)).rejects.toThrow(
      'Proxies cannot access notifications'
    );
    expect(mockGetNotificationsV2).not.toHaveBeenCalled();
  });
});
