const mockRoutes: { method: string; path: string; handler: any }[] = [];

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => {
    const register =
      (method: string) =>
      (path: string, ...handlers: any[]) => {
        mockRoutes.push({ method, path, handler: handlers.at(-1) });
      };
    return {
      get: register('get'),
      post: register('post'),
      put: register('put'),
      delete: register('delete'),
      use: jest.fn()
    };
  }
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser: () => jest.fn()
}));

jest.mock('./push-notification-settings.db', () => ({
  pushNotificationSettingsDb: {
    getPushNotificationSettings: jest.fn(),
    upsertPushNotificationSettings: jest.fn()
  }
}));

jest.mock('./push-notifications.db', () => ({
  deleteDevice: jest.fn(),
  getDevicesForProfile: jest.fn()
}));

jest.mock('./push-notifications.service', () => ({
  requestInstallationBadgeRefresh: jest.fn()
}));

jest.mock('./push-installation.db', () => ({
  registerInstallationDevice: jest.fn()
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { pushNotificationSettingsDb } from './push-notification-settings.db';
import { deleteDevice, getDevicesForProfile } from './push-notifications.db';
import { registerInstallationDevice } from './push-installation.db';
import './push-notifications.routes';

function proxyContext() {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: 'grantor-profile',
    activeProxyActions: Object.values(ProfileProxyActionType).map(
      (type, index) => ({
        id: `action-${index}`,
        type,
        credit_amount: null,
        credit_spent: null
      })
    )
  });
}

function makeResponse() {
  const res = { status: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

const validRegisterBody = {
  token: 'push-token',
  device_id: 'device-1',
  platform: 'ios',
  installation_secret: 'a'.repeat(64),
  installation_revision: 1
};

describe('push notification routes for proxy sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getAuthenticationContext).mockResolvedValue(proxyContext());
  });

  it('registers every route', () => {
    expect(mockRoutes.map((it) => `${it.method} ${it.path}`)).toEqual([
      'post /register',
      'get /devices',
      'delete /devices/:device_id',
      'get /settings/:device_id',
      'put /settings/:device_id'
    ]);
  });

  it.each([
    ['post', '/register', { body: validRegisterBody, params: {} }],
    ['get', '/devices', { body: {}, params: {} }],
    ['delete', '/devices/:device_id', { body: {}, params: { device_id: 'd' } }],
    ['get', '/settings/:device_id', { body: {}, params: { device_id: 'd' } }],
    [
      'put',
      '/settings/:device_id',
      { body: { drop_quoted: true }, params: { device_id: 'd' } }
    ]
  ])('rejects a proxy on %s %s', async (method, path, req) => {
    const route = mockRoutes.find(
      (it) => it.method === method && it.path === path
    )!;

    await expect(route.handler(req, makeResponse())).rejects.toThrow(
      new ForbiddenException('Proxies cannot manage push notifications')
    );

    expect(registerInstallationDevice).not.toHaveBeenCalled();
    expect(getDevicesForProfile).not.toHaveBeenCalled();
    expect(deleteDevice).not.toHaveBeenCalled();
    expect(
      pushNotificationSettingsDb.getPushNotificationSettings
    ).not.toHaveBeenCalled();
    expect(
      pushNotificationSettingsDb.upsertPushNotificationSettings
    ).not.toHaveBeenCalled();
  });

  it('still serves direct sessions', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('member'));
    jest.mocked(getDevicesForProfile).mockResolvedValue([]);
    const route = mockRoutes.find(
      (it) => it.method === 'get' && it.path === '/devices'
    )!;
    const res = makeResponse();

    await route.handler({ body: {}, params: {} }, res);

    expect(getDevicesForProfile).toHaveBeenCalledWith('member');
    expect(res.send).toHaveBeenCalledWith([]);
  });
});
