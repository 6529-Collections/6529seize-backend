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

jest.mock('../proxies/proxy.api.service', () => ({
  ...jest.requireActual('../proxies/proxy.api.service'),
  profileProxyApiService: { getProxyByGrantedByAndGrantedTo: jest.fn() }
}));

import { profileProxyApiService } from '../proxies/proxy.api.service';
import { invalidateCachedProxyAuthenticationContexts } from './auth-context-cache';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';

const getProxy = jest.mocked(
  profileProxyApiService.getProxyByGrantedByAndGrantedTo
);

function proxyWith(actions: Array<Record<string, unknown>>): any {
  return {
    id: 'proxy-1',
    created_at: 1,
    created_by: { id: 'grantor' },
    granted_to: { id: 'grantee' },
    actions: actions.map((action) => ({
      id: 'action-1',
      proxy_id: 'proxy-1',
      action_type: 'CREATE_DROP_TO_WAVE',
      credit_amount: null,
      credit_spent: null,
      created_at: 1,
      start_time: 1,
      end_time: null,
      accepted_at: 2,
      rejected_at: null,
      revoked_at: null,
      is_active: true,
      wave_allowlist: null,
      ...action
    }))
  };
}

describe('getAuthenticationContext proxy wave allowlist', () => {
  const wallet = '0x00000000000000000000000000000000000000c3';
  const proxyRequest = { user: { wallet, role: 'grantor' } } as any;

  beforeEach(() => {
    mcache.clear();
    getProfileIdByWallet.mockReset();
    getProfileIdByWallet.mockResolvedValue('grantee');
    getProxy.mockReset();
  });

  it('carries the grant allowlist into the context', async () => {
    getProxy.mockResolvedValue(proxyWith([{ wave_allowlist: ['wave-1'] }]));
    const ctx = await getAuthenticationContext(proxyRequest);
    expect(ctx.isAuthenticatedAsProxy()).toBe(true);
    expect(
      ctx.activeProxyActions[ProfileProxyActionType.CREATE_DROP_TO_WAVE]
        ?.wave_allowlist
    ).toEqual(['wave-1']);
    expect(ctx.hasRightsToPostInWave('wave-1')).toBe(true);
    expect(ctx.hasRightsToPostInWave('wave-2')).toBe(false);
  });

  it('treats a legacy grant row without the field as unrestricted', async () => {
    getProxy.mockResolvedValue(proxyWith([{ wave_allowlist: undefined }]));
    const ctx = await getAuthenticationContext(proxyRequest);
    expect(
      ctx.activeProxyActions[ProfileProxyActionType.CREATE_DROP_TO_WAVE]
        ?.wave_allowlist
    ).toBeNull();
    expect(ctx.hasRightsToPostInWave('wave-2')).toBe(true);
  });

  it('serves the cached grant until it is invalidated, then re-reads it', async () => {
    getProxy.mockResolvedValueOnce(proxyWith([{ wave_allowlist: ['wave-1'] }]));
    const first = await getAuthenticationContext(proxyRequest);
    expect(first.hasRightsToPostInWave('wave-1')).toBe(true);

    // The grantor revokes the action: without invalidation this instance
    // would keep answering from the cached context.
    getProxy.mockResolvedValue(
      proxyWith([{ wave_allowlist: ['wave-1'], revoked_at: 3 }])
    );
    const stillCached = await getAuthenticationContext(proxyRequest);
    expect(stillCached.hasRightsToPostInWave('wave-1')).toBe(true);
    expect(getProxy).toHaveBeenCalledTimes(1);

    invalidateCachedProxyAuthenticationContexts({
      granteeWallets: [wallet.toUpperCase()],
      grantorProfileId: 'grantor'
    });
    const afterRevoke = await getAuthenticationContext(proxyRequest);
    expect(afterRevoke.hasRightsToPostInWave('wave-1')).toBe(false);
    expect(
      afterRevoke.hasProxyAction(ProfileProxyActionType.CREATE_DROP_TO_WAVE)
    ).toBe(false);
    expect(getProxy).toHaveBeenCalledTimes(2);
  });

  it('invalidation of another role leaves this context cached', async () => {
    getProxy.mockResolvedValue(proxyWith([{ wave_allowlist: ['wave-1'] }]));
    await getAuthenticationContext(proxyRequest);
    invalidateCachedProxyAuthenticationContexts({
      granteeWallets: [wallet],
      grantorProfileId: 'someone-else'
    });
    await getAuthenticationContext(proxyRequest);
    expect(getProxy).toHaveBeenCalledTimes(1);
  });
});
