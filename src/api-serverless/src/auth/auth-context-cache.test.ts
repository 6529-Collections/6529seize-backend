import * as mcache from 'memory-cache';
import { identitiesDb } from '../../../identities/identities.db';
import { getAuthenticationContext } from './auth';

jest.mock('../../../identities/identities.db', () => ({
  identitiesDb: { getProfileIdByWallet: jest.fn() }
}));

const getProfileIdByWallet = identitiesDb.getProfileIdByWallet as jest.Mock;

function requestFor(wallet: string): any {
  return { user: { wallet, role: null } };
}

describe('getAuthenticationContext cache', () => {
  beforeEach(() => {
    mcache.clear();
    getProfileIdByWallet.mockReset();
  });

  it('does not cache a wallet without a profile, so a new profile is seen at once', async () => {
    const wallet = '0x00000000000000000000000000000000000000a1';
    getProfileIdByWallet.mockResolvedValueOnce(null);
    const before = await getAuthenticationContext(requestFor(wallet));
    expect(before.getActingAsId()).toBeNull();

    getProfileIdByWallet.mockResolvedValueOnce('profile-1');
    const after = await getAuthenticationContext(requestFor(wallet));
    expect(after.getActingAsId()).toBe('profile-1');
    expect(getProfileIdByWallet).toHaveBeenCalledTimes(2);
  });

  it('still caches a wallet that has a profile', async () => {
    const wallet = '0x00000000000000000000000000000000000000b2';
    getProfileIdByWallet.mockResolvedValue('profile-2');
    await getAuthenticationContext(requestFor(wallet));
    const second = await getAuthenticationContext(requestFor(wallet));
    expect(second.getActingAsId()).toBe('profile-2');
    expect(getProfileIdByWallet).toHaveBeenCalledTimes(1);
  });

  it('keeps each access-token session on its own context', async () => {
    const wallet = '0x00000000000000000000000000000000000000c3';
    getProfileIdByWallet.mockResolvedValue('profile-3');
    const web = {
      user: {
        wallet,
        role: null,
        clientType: 'web',
        binding: 'siwe',
        sessionId: '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e'
      }
    } as any;
    const legacy = {
      user: { wallet, role: null, clientType: 'legacy' }
    } as any;

    const webContext = await getAuthenticationContext(web);
    const legacyContext = await getAuthenticationContext(legacy);
    const oldTokenContext = await getAuthenticationContext(requestFor(wallet));

    expect(webContext.accessTokenSession).toEqual({
      clientType: 'web',
      binding: 'siwe',
      sessionId: '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e'
    });
    expect(legacyContext.accessTokenSession).toEqual({
      clientType: 'legacy',
      binding: null,
      sessionId: null
    });
    expect(oldTokenContext.accessTokenSession).toBeNull();
    expect(oldTokenContext.getActingAsId()).toBe('profile-3');
    expect((await getAuthenticationContext(web)).accessTokenSession).toEqual(
      webContext.accessTokenSession
    );
  });
});
