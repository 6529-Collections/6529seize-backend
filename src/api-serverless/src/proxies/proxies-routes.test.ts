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

jest.mock('../auth/auth', () => ({
  getWalletOrThrow: () => '0xwallet',
  needsAuthenticatedUser: () => jest.fn()
}));

jest.mock('../identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: jest.fn().mockResolvedValue('grantor')
  }
}));

jest.mock('./proxy.api.service', () => ({
  profileProxyApiService: {
    updateProfileProxyAction: jest.fn().mockResolvedValue({ id: 'action' })
  }
}));

import { profileProxyApiService } from './proxy.api.service';

require('./proxies.routes');

function putAction() {
  const route = mockRoutes.find(
    (it) => it.method === 'put' && it.path === '/:proxy_id/actions/:action_id'
  );
  if (!route) throw new Error('PUT action route not registered');
  return route.handler;
}

function request(body: unknown) {
  return {
    params: { proxy_id: 'proxy', action_id: 'action' },
    body,
    get: jest.fn()
  };
}

describe('PUT /proxies/:proxy_id/actions/:action_id', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([0, 1, 250])('accepts the credit amount %s', async (amount) => {
    const res = { send: jest.fn() };
    await putAction()(request({ credit_amount: amount }), res);
    expect(
      profileProxyApiService.updateProfileProxyAction
    ).toHaveBeenCalledWith(expect.objectContaining({ credit_amount: amount }));
  });

  it.each([-1, 1.5, -0.5])(
    'requires a non-negative integer credit amount, not %s',
    async (amount) => {
      await expect(
        putAction()(request({ credit_amount: amount }), { send: jest.fn() })
      ).rejects.toThrow();
      expect(
        profileProxyApiService.updateProfileProxyAction
      ).not.toHaveBeenCalled();
    }
  );
});
