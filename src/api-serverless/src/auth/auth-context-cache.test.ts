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
});
