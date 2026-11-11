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

jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('./notifications.api.service', () => ({
  notificationsApiService: {
    getWaveSubscription: jest.fn(),
    updateWaveSubscription: jest.fn(),
    clearWaveSubscription: jest.fn()
  }
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { notificationsApiService } from './notifications.api.service';
import './notifications.routes';

function proxyContext() {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: 'grantor-profile',
    activeProxyActions: [
      {
        id: 'action-1',
        type: ProfileProxyActionType.READ_WAVE,
        credit_amount: null,
        credit_spent: null
      }
    ]
  });
}

function routeFor(method: string) {
  return mockRoutes.find(
    (it) => it.method === method && it.path === '/wave-subscription/:wave_id'
  )!.handler;
}

describe('wave subscription routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['get', 'post', 'delete'])(
    'rejects a proxy session on %s',
    async (method) => {
      jest.mocked(getAuthenticationContext).mockResolvedValue(proxyContext());

      await expect(
        routeFor(method)(
          { params: { wave_id: 'wave-1' }, body: {} },
          { send: jest.fn() }
        )
      ).rejects.toThrow(
        new ForbiddenException(
          'Proxies cannot manage wave notification subscriptions'
        )
      );

      expect(
        notificationsApiService.getWaveSubscription
      ).not.toHaveBeenCalled();
      expect(
        notificationsApiService.updateWaveSubscription
      ).not.toHaveBeenCalled();
      expect(
        notificationsApiService.clearWaveSubscription
      ).not.toHaveBeenCalled();
    }
  );

  it('serves a direct session', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('member'));
    jest
      .mocked(notificationsApiService.getWaveSubscription)
      .mockResolvedValue({ subscribed: true, enabled_group_notifications: [] });
    const res = { send: jest.fn() };

    await routeFor('get')({ params: { wave_id: 'wave-1' }, body: {} }, res);

    expect(notificationsApiService.getWaveSubscription).toHaveBeenCalledWith(
      'member',
      'wave-1'
    );
    expect(res.send).toHaveBeenCalledWith({
      subscribed: true,
      enabled_group_notifications: []
    });
  });
});
