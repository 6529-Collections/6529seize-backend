const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const mockIsIdentityFrozen = jest.fn();
const mockIsXTdhEnabled = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockUpdateXTdhGrant = jest.fn();
const mockCreateXTdhGrant = jest.fn();

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({ get: mockRouterGet, post: mockRouterPost })
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext,
  maybeAuthenticatedUser: () => jest.fn(),
  needsAuthenticatedUser: () => jest.fn()
}));

jest.mock('@/app-features', () => ({
  appFeatures: {
    isIdentityFrozen: mockIsIdentityFrozen,
    isXTdhEnabled: mockIsXTdhEnabled
  }
}));

jest.mock('@/xtdh/xtdh-grants.finder', () => ({
  xTdhGrantsFinder: { updateXTdhGrant: mockUpdateXTdhGrant }
}));

jest.mock('@/xtdh/create-xtdh-grant.use-case', () => ({
  createXTdhGrantUseCase: { handle: mockCreateXTdhGrant }
}));

jest.mock('./xtdh-grant.api-converter', () => ({
  xTdhGrantApiConverter: {}
}));

import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import { XTDH_RETIRED_MESSAGE } from '@/xtdh/xtdh-retired';
import './xtdh-grants.routes';

const postHandlers = new Map<string, any>(
  mockRouterPost.mock.calls.map((c) => [c[0], c[c.length - 1]])
);

function postHandler(path: string) {
  const handler = postHandlers.get(path);
  if (!handler) throw new Error(`no POST ${path}`);
  return handler;
}

const request = (params: Record<string, string> = {}) =>
  ({
    params,
    body: { valid_to: null },
    query: {},
    get: () => undefined
  }) as any;

const response = () => ({ send: jest.fn(), status: jest.fn() }) as any;

describe('xTDH grant routes once xTDH is retired', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.IDENTITY_FREEZE_AT;
    mockIsXTdhEnabled.mockReturnValue(true);
    mockGetAuthenticationContext.mockResolvedValue({
      getActingAsId: () => 'grantor',
      isAuthenticatedAsProxy: () => false
    });
  });

  it('refuses a new grant, saying xTDH is retired', async () => {
    mockIsIdentityFrozen.mockReturnValue(true);
    const res = response();
    const error = await postHandler('/')(request(), res).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(IdentityFrozenException);
    expect((error as Error).message).toBe(XTDH_RETIRED_MESSAGE);
    expect(mockCreateXTdhGrant).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('refuses a change to a grant', async () => {
    mockIsIdentityFrozen.mockReturnValue(true);
    const error = await postHandler('/:id')(
      request({ id: 'g1' }),
      response()
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityFrozenException);
    expect(mockUpdateXTdhGrant).not.toHaveBeenCalled();
  });

  it('passes a change to a grant through before the retirement', async () => {
    mockIsIdentityFrozen.mockReturnValue(false);
    mockUpdateXTdhGrant.mockRejectedValue(new Error('reached the finder'));
    await expect(
      postHandler('/:id')(request({ id: 'g1' }), response())
    ).rejects.toThrow('reached the finder');
  });
});
