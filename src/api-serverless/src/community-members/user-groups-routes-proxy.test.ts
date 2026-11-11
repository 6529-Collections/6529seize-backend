const mockRoutes: {
  file: string;
  method: string;
  path: string;
  handler: any;
}[] = [];
let mockCurrentFile = '';

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => {
    const file = mockCurrentFile;
    const register =
      (method: string) =>
      (path: string, ...handlers: any[]) => {
        mockRoutes.push({ file, method, path, handler: handlers.at(-1) });
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

jest.mock('./user-groups.service', () => ({
  userGroupsService: {
    changeVisibility: jest.fn(),
    getGroupsUserIsEligibleFor: jest.fn(),
    save: jest.fn()
  }
}));

jest.mock('@/api/waves/wave.api.service', () => ({
  waveApiService: {
    assertGroupReplacementPreservesWaveViewAccess: jest.fn()
  }
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { userGroupsService } from './user-groups.service';

mockCurrentFile = 'user-groups';
require('./user-groups.routes');
mockCurrentFile = 'eligible-for';
require('./user-groups-im-elgigible-for.routes');

describe('route registration', () => {
  it('registers the routes exercised below', () => {
    expect(
      mockRoutes.map(({ file, method, path }) => `${file} ${method} ${path}`)
    ).toEqual(
      expect.arrayContaining([
        'user-groups post /',
        'user-groups post /:group_id/visible',
        'eligible-for get /'
      ])
    );
  });
});

function proxyContext(actions: ProfileProxyActionType[]) {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: 'grantor-profile',
    activeProxyActions: actions.map((type, index) => ({
      id: `action-${index}`,
      type,
      credit_amount: null,
      credit_spent: null
    }))
  });
}

function route(file: string, method: string, path: string) {
  const registered = mockRoutes.find(
    (it) => it.file === file && it.method === method && it.path === path
  );
  if (!registered) {
    throw new Error(`Route not registered: ${file} ${method} ${path}`);
  }
  return registered.handler;
}

function request() {
  return {
    params: { group_id: 'group-1' },
    body: { visible: true, old_version_id: null },
    get: jest.fn()
  };
}

describe('POST /groups/:group_id/visible', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a proxy session even with every proxy action', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(proxyContext(Object.values(ProfileProxyActionType)));

    await expect(
      route(
        'user-groups',
        'post',
        '/:group_id/visible'
      )(request(), {
        send: jest.fn()
      })
    ).rejects.toThrow(
      new ForbiddenException('Proxies cannot change group visibility')
    );
    expect(userGroupsService.changeVisibility).not.toHaveBeenCalled();
  });

  it('lets a direct session change visibility', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('member'));
    jest
      .mocked(userGroupsService.changeVisibility)
      .mockResolvedValue({ id: 'group-1' } as any);
    const res = { send: jest.fn() };

    await route('user-groups', 'post', '/:group_id/visible')(request(), res);

    expect(userGroupsService.changeVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ profile_id: 'member', group_id: 'group-1' }),
      expect.anything(),
      expect.any(Function)
    );
    expect(res.send).toHaveBeenCalledWith({ id: 'group-1' });
  });
});

describe('POST /groups', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a proxy session even with every proxy action', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(proxyContext(Object.values(ProfileProxyActionType)));

    await expect(
      route('user-groups', 'post', '/')({ body: {} }, { send: jest.fn() })
    ).rejects.toThrow(new ForbiddenException('Proxies cannot create groups'));
    expect(userGroupsService.save).not.toHaveBeenCalled();
  });
});

describe('GET /groups-im-eligible-for', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns no groups to a proxy without READ_WAVE', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(proxyContext([ProfileProxyActionType.CREATE_WAVE]));
    const res = { send: jest.fn() };

    await route('eligible-for', 'get', '/')({}, res);

    expect(res.send).toHaveBeenCalledWith([]);
    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a proxy with READ_WAVE',
      proxyContext([ProfileProxyActionType.READ_WAVE])
    ],
    ['a direct session', AuthenticationContext.fromProfileId('grantor-profile')]
  ])('returns the acting profile groups to %s', async (_label, context) => {
    jest.mocked(getAuthenticationContext).mockResolvedValue(context);
    jest
      .mocked(userGroupsService.getGroupsUserIsEligibleFor)
      .mockResolvedValue(['group-1']);
    const res = { send: jest.fn() };

    await route('eligible-for', 'get', '/')({}, res);

    expect(userGroupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'grantor-profile',
      undefined
    );
    expect(res.send).toHaveBeenCalledWith(['group-1']);
  });
});
