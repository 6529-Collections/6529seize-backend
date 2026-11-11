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
  needsAuthenticatedUser: () => jest.fn(),
  maybeAuthenticatedUser: () => jest.fn()
}));

jest.mock('./identities.service', () => ({
  identitiesService: {
    addIdentitySubscriptionActions: jest.fn(),
    removeIdentitySubscriptionActions: jest.fn()
  }
}));

jest.mock('./identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: jest.fn(),
    getOverviewsByIds: jest.fn(),
    getIdentityAndConsolidationsByIdentityKey: jest.fn()
  }
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { identitiesService } from './identities.service';
import { identityFetcher } from './identity.fetcher';
import './identities.routes';

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

function routeFor(method: string) {
  return mockRoutes.find(
    (it) => it.method === method && it.path === '/:id/subscriptions'
  )!.handler;
}

describe('identity subscription routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['get', 'post', 'delete'])(
    'rejects a proxy session on %s',
    async (method) => {
      jest.mocked(getAuthenticationContext).mockResolvedValue(proxyContext());

      await expect(
        routeFor(method)(
          {
            params: { id: 'target' },
            body: { actions: ['DROP_CREATED'] }
          },
          { send: jest.fn() }
        )
      ).rejects.toThrow(
        new ForbiddenException('Proxies cannot manage identity subscriptions')
      );

      expect(identityFetcher.getProfileIdByIdentityKey).not.toHaveBeenCalled();
      expect(
        identitiesService.addIdentitySubscriptionActions
      ).not.toHaveBeenCalled();
      expect(
        identitiesService.removeIdentitySubscriptionActions
      ).not.toHaveBeenCalled();
    }
  );

  it('lets a direct session follow an identity', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('member'));
    jest
      .mocked(identityFetcher.getIdentityAndConsolidationsByIdentityKey)
      .mockResolvedValue({ primary_wallet: '0xtarget' } as any);
    jest
      .mocked(identitiesService.addIdentitySubscriptionActions)
      .mockResolvedValue(['DROP_CREATED'] as any);
    const res = { send: jest.fn() };

    await routeFor('post')(
      { params: { id: 'target' }, body: { actions: ['DROP_CREATED'] } },
      res
    );

    expect(
      identitiesService.addIdentitySubscriptionActions
    ).toHaveBeenCalledWith({
      identityAddress: '0xtarget',
      subscriber: 'member',
      actions: ['DROP_CREATED']
    });
    expect(res.send).toHaveBeenCalledWith({ actions: ['DROP_CREATED'] });
  });
});
