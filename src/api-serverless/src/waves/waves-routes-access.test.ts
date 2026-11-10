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

jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('./wave.api.service', () => ({
  waveApiService: {
    muteWave: jest.fn(),
    unmuteWave: jest.fn(),
    findOrCreateDirectMessageWave: jest.fn()
  }
}));

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {
    findOrCreateDirectMessageGroup: jest.fn(),
    getGroupsUserIsEligibleFor: jest.fn()
  }
}));

jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {
    getIdentityAndConsolidationsByIdentityKey: jest.fn()
  }
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { waveApiService } from './wave.api.service';
import './waves.routes';

const CREATOR_WALLET = '0x1111111111111111111111111111111111111111';
const RECIPIENT_WALLET = '0x2222222222222222222222222222222222222222';

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

function route(method: string, path: string) {
  return mockRoutes.find((it) => it.method === method && it.path === path)!
    .handler;
}

describe('wave mute routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['post', 'Proxy is not allowed to mute waves'],
    ['delete', 'Proxy is not allowed to unmute waves']
  ])('rejects a proxy session on %s /:id/mute', async (method, message) => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(proxyContext(Object.values(ProfileProxyActionType)));

    await expect(
      route(method, '/:id/mute')(
        { params: { id: 'wave-1' } },
        { send: jest.fn() }
      )
    ).rejects.toThrow(new ForbiddenException(message));

    expect(waveApiService.muteWave).not.toHaveBeenCalled();
    expect(waveApiService.unmuteWave).not.toHaveBeenCalled();
  });

  it('lets a direct session mute a wave', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('member'));
    const res = { send: jest.fn() };

    await route('post', '/:id/mute')({ params: { id: 'wave-1' } }, res);

    expect(waveApiService.muteWave).toHaveBeenCalledWith(
      { waveId: 'wave-1' },
      expect.anything()
    );
    expect(res.send).toHaveBeenCalledWith({});
  });
});

describe('POST /waves/direct-message/new', () => {
  const originalCutoff = process.env.LEGACY_DM_DELETION_CUTOFF;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LEGACY_DM_DELETION_CUTOFF = '2999-01-01T00:00:00Z';
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('creator'));
    jest
      .mocked(identityFetcher.getIdentityAndConsolidationsByIdentityKey)
      .mockResolvedValue({
        id: 'creator',
        primary_wallet: CREATOR_WALLET,
        wallets: [{ wallet: CREATOR_WALLET }]
      } as any);
    jest
      .mocked(userGroupsService.findOrCreateDirectMessageGroup)
      .mockResolvedValue({ id: 'dm-group' } as any);
    jest
      .mocked(waveApiService.findOrCreateDirectMessageWave)
      .mockResolvedValue({ id: 'dm-wave' } as any);
  });

  afterAll(() => {
    if (originalCutoff === undefined) {
      delete process.env.LEGACY_DM_DELETION_CUTOFF;
    } else {
      process.env.LEGACY_DM_DELETION_CUTOFF = originalCutoff;
    }
  });

  function createDm(identityAddresses: unknown) {
    return route('post', '/direct-message/new')(
      { body: { identity_addresses: identityAddresses } },
      { send: jest.fn() }
    );
  }

  it('rejects the creator own wallet as a recipient', async () => {
    await expect(
      createDm([
        RECIPIENT_WALLET,
        CREATOR_WALLET.toUpperCase().replace('0X', '0x')
      ])
    ).rejects.toThrow(new BadRequestException('You cannot DM yourself.'));
    expect(
      userGroupsService.findOrCreateDirectMessageGroup
    ).not.toHaveBeenCalled();
  });

  it('passes de-duplicated lowercase recipients to group creation', async () => {
    await createDm([
      RECIPIENT_WALLET,
      RECIPIENT_WALLET.toUpperCase().replace('0X', '0x')
    ]);

    expect(
      userGroupsService.findOrCreateDirectMessageGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'creator' }),
      [RECIPIENT_WALLET],
      expect.anything()
    );
  });

  it('rejects recipients that are not wallet addresses', async () => {
    await expect(createDm(['some-handle'])).rejects.toThrow(
      BadRequestException
    );
    expect(
      userGroupsService.findOrCreateDirectMessageGroup
    ).not.toHaveBeenCalled();
  });
});
