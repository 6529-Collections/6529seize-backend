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
  getAuthenticationContext: jest.fn().mockResolvedValue({}),
  needsAuthenticatedUser: () => jest.fn()
}));

jest.mock('./cms.api.service', () => ({
  cmsApiService: { publishPackage: jest.fn().mockResolvedValue({}) }
}));

import { cmsApiService } from './cms.api.service';

require('./cms.routes');

const HASH =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function publish(body: Record<string, unknown>) {
  const route = mockRoutes.find(
    (it) =>
      it.method === 'post' && it.path === '/sites/:site_id/published-packages'
  );
  if (!route) throw new Error('publish route not registered');
  const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
  return route.handler(
    {
      params: { site_id: 'site-1' },
      body: {
        package_hash: HASH,
        payload_hash: HASH,
        schema: '6529.cms.package.v1',
        title: 'Title',
        static_path: '/punk6529/index.html',
        package_json: {},
        storage: [{ provider: 'ipfs', uri: 'ipfs://x', pinned: true }],
        signature: {},
        ...body
      },
      get: jest.fn()
    },
    res
  );
}

describe('POST /cms/sites/:site_id/published-packages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts an https canonical_url', async () => {
    await publish({ canonical_url: 'https://6529.io/punk6529' });
    expect(cmsApiService.publishPackage).toHaveBeenCalled();
  });

  it.each([
    'http://6529.io/punk6529',
    'javascript:alert(1)',
    'data:text/html,x',
    'ipfs://bafy'
  ])('requires an https canonical_url, not %s', async (canonical_url) => {
    await expect(publish({ canonical_url })).rejects.toThrow();
    expect(cmsApiService.publishPackage).not.toHaveBeenCalled();
  });
});
