import { ProfileProxyApiService } from './proxy.api.service';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { BadRequestException } from '@/exceptions';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import * as authContextCache from '@/api/auth/auth-context-cache';
import { Time } from '@/time';

jest.mock('@/profileActivityLogs/profile-activity-logs.db', () => ({
  profileActivityLogsDb: { insert: jest.fn().mockResolvedValue(undefined) }
}));

const PROXY = {
  id: 'proxy-1',
  created_at: 1,
  created_by: { id: 'grantor' },
  granted_to: { id: 'grantee' },
  actions: [] as any[]
} as any;

function storedAction(
  overrides: Partial<{
    id: string;
    action_type: ProfileProxyActionType;
    wave_allowlist: string[] | null;
    accepted_at: number | null;
    revoked_at: number | null;
    end_time: number | null;
  }> = {}
) {
  return {
    id: 'action-1',
    proxy_id: PROXY.id,
    action_type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
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
    ...overrides
  };
}

function makeService(stored = storedAction()) {
  const db = {
    executeNativeQueriesInTransaction: jest.fn(async (cb: any) => cb({})),
    findProfileProxyActionsByProxyIdAndActionType: jest
      .fn()
      .mockResolvedValue([]),
    insertProfileProxyAction: jest.fn().mockResolvedValue({ actionId: 'new' }),
    findProfileProxyActionById: jest.fn().mockResolvedValue(stored),
    findProfileProxyById: jest.fn().mockResolvedValue({
      id: PROXY.id,
      target_id: 'grantee',
      created_by: 'grantor',
      created_at: 1
    }),
    findProfileProxyActionsByProxyId: jest.fn().mockResolvedValue([stored]),
    findProfileProxyGrantedActionsByGrantorAndGrantee: jest
      .fn()
      .mockResolvedValue([stored]),
    findProfileProxiesByGrantorAndGrantee: jest
      .fn()
      .mockResolvedValue([{ id: PROXY.id }]),
    updateProfileProxyAction: jest.fn().mockResolvedValue(undefined),
    acceptProfileProxyAction: jest.fn().mockResolvedValue(undefined),
    revokeProfileProxyAction: jest.fn().mockResolvedValue(undefined)
  };
  const identityFetcher = {
    getIdentityAndConsolidationsByIdentityKey: jest.fn().mockResolvedValue({
      wallets: [{ wallet: '0xABC' }, { wallet: '0xdef' }]
    })
  };
  const mapper = {
    profileProxyEntitiesToApiProfileProxies: jest.fn(
      async ({ actions }: { actions: any[] }) => [
        {
          ...PROXY,
          actions: actions.map((it) => ({
            ...it,
            action_type: it.action_type
          }))
        }
      ]
    )
  };
  const service = new ProfileProxyApiService(
    identityFetcher as any,
    db as any,
    mapper as any
  );
  return { service, db, identityFetcher, mapper };
}

describe('ProfileProxyApiService wave allowlist', () => {
  const invalidate = jest.spyOn(
    authContextCache,
    'invalidateCachedProxyAuthenticationContexts'
  );

  beforeEach(() => {
    invalidate.mockClear();
    jest.mocked(profileActivityLogsDb.insert).mockClear();
  });

  describe('createProfileProxyAction', () => {
    it('persists the allowlist of a CREATE_DROP_TO_WAVE grant and invalidates the grantee cache', async () => {
      const { service, db } = makeService();
      await service.createProfileProxyAction({
        proxy: PROXY,
        action: {
          action_type: ApiProfileProxyActionType.CreateDropToWave,
          end_time: null,
          wave_allowlist: ['wave-1', 'wave-2']
        }
      });
      expect(db.insertProfileProxyAction).toHaveBeenCalledWith(
        expect.objectContaining({
          profileProxyAction: expect.objectContaining({
            action_type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
            wave_allowlist: ['wave-1', 'wave-2']
          })
        })
      );
      expect(invalidate).toHaveBeenCalledWith({
        granteeWallets: ['0xABC', '0xdef'],
        grantorProfileId: 'grantor'
      });
    });

    it('stores null when the allowlist is omitted or null (legacy unrestricted)', async () => {
      for (const wave_allowlist of [undefined, null]) {
        const { service, db } = makeService();
        await service.createProfileProxyAction({
          proxy: PROXY,
          action: {
            action_type: ApiProfileProxyActionType.CreateDropToWave,
            end_time: null,
            ...(wave_allowlist === undefined ? {} : { wave_allowlist })
          } as any
        });
        expect(db.insertProfileProxyAction).toHaveBeenCalledWith(
          expect.objectContaining({
            profileProxyAction: expect.objectContaining({
              wave_allowlist: null
            })
          })
        );
      }
    });

    it.each([
      ['an empty list', []],
      ['duplicates', ['wave-1', 'wave-1']],
      ['a non-string entry', ['wave-1', 7]],
      ['a non-array', 'wave-1']
    ])(
      'rejects %s with 400 and persists nothing',
      async (_label, wave_allowlist) => {
        const { service, db } = makeService();
        await expect(
          service.createProfileProxyAction({
            proxy: PROXY,
            action: {
              action_type: ApiProfileProxyActionType.CreateDropToWave,
              end_time: null,
              wave_allowlist
            } as any
          })
        ).rejects.toThrow(BadRequestException);
        expect(db.insertProfileProxyAction).not.toHaveBeenCalled();
        expect(db.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
      }
    );

    it('rejects an allowlist on any other action type', async () => {
      const { service, db } = makeService();
      await expect(
        service.createProfileProxyAction({
          proxy: PROXY,
          action: {
            action_type: ApiProfileProxyActionType.ReadWave,
            end_time: null,
            wave_allowlist: ['wave-1']
          } as any
        })
      ).rejects.toThrow('only supported for CREATE_DROP_TO_WAVE');
      expect(db.insertProfileProxyAction).not.toHaveBeenCalled();
    });

    it('does not fail the request when the cache invalidation lookup fails', async () => {
      const { service, identityFetcher } = makeService();
      identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockRejectedValue(
        new Error('identity service down')
      );
      await expect(
        service.createProfileProxyAction({
          proxy: PROXY,
          action: {
            action_type: ApiProfileProxyActionType.CreateDropToWave,
            end_time: null,
            wave_allowlist: ['wave-1']
          }
        })
      ).resolves.toEqual(expect.objectContaining({ id: 'action-1' }));
    });
  });

  describe('updateProfileProxyAction', () => {
    const base = {
      profile_id: 'grantor',
      proxy_id: PROXY.id,
      action_id: 'action-1'
    };

    it('replaces the scope with the new list and invalidates the grantee cache', async () => {
      const { service, db } = makeService(
        storedAction({ wave_allowlist: ['wave-1'] })
      );
      await service.updateProfileProxyAction({
        ...base,
        wave_allowlist: ['wave-2', 'wave-3']
      });
      expect(db.updateProfileProxyAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action_id: 'action-1',
          wave_allowlist: ['wave-2', 'wave-3']
        })
      );
      expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it('leaves the stored scope untouched when the field is omitted', async () => {
      const { service, db } = makeService(
        storedAction({ wave_allowlist: ['wave-1'] })
      );
      await service.updateProfileProxyAction({ ...base, end_time: 99 });
      expect(db.updateProfileProxyAction).toHaveBeenCalledWith(
        expect.objectContaining({ end_time: 99, wave_allowlist: undefined })
      );
    });

    it('refuses to lift a scope with null', async () => {
      const { service, db } = makeService(
        storedAction({ wave_allowlist: ['wave-1'] })
      );
      await expect(
        service.updateProfileProxyAction({ ...base, wave_allowlist: null })
      ).rejects.toThrow('cannot be lifted');
      expect(db.updateProfileProxyAction).not.toHaveBeenCalled();
    });

    it('refuses an empty or malformed replacement', async () => {
      const { service, db } = makeService(
        storedAction({ wave_allowlist: ['wave-1'] })
      );
      await expect(
        service.updateProfileProxyAction({ ...base, wave_allowlist: [] })
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateProfileProxyAction({
          ...base,
          wave_allowlist: ['a', 'a']
        })
      ).rejects.toThrow(BadRequestException);
      expect(db.updateProfileProxyAction).not.toHaveBeenCalled();
    });

    it('refuses a scope on an action type that has none', async () => {
      const { service, db } = makeService(
        storedAction({ action_type: ProfileProxyActionType.READ_WAVE })
      );
      await expect(
        service.updateProfileProxyAction({
          ...base,
          wave_allowlist: ['wave-1']
        })
      ).rejects.toThrow('only supported for CREATE_DROP_TO_WAVE');
      expect(db.updateProfileProxyAction).not.toHaveBeenCalled();
    });

    it('still requires something to update', async () => {
      const { service } = makeService();
      await expect(service.updateProfileProxyAction(base)).rejects.toThrow(
        BadRequestException
      );
    });

    it('only the grantor may change the scope', async () => {
      const { service } = makeService();
      await expect(
        service.updateProfileProxyAction({
          ...base,
          profile_id: 'grantee',
          wave_allowlist: ['wave-1']
        })
      ).rejects.toThrow('not the creator');
    });
  });

  describe('hasActiveProxyAction with a wave', () => {
    const pair = {
      granted_by_profile_id: 'grantor',
      granted_to_profile_id: 'grantee',
      action: ProfileProxyActionType.CREATE_DROP_TO_WAVE
    };

    it('is true for a listed wave and false for an unlisted one', async () => {
      const { service } = makeService(
        storedAction({ wave_allowlist: ['wave-1'] })
      );
      await expect(
        service.hasActiveProxyAction({ ...pair, wave_id: 'wave-1' })
      ).resolves.toBe(true);
      await expect(
        service.hasActiveProxyAction({ ...pair, wave_id: 'wave-2' })
      ).resolves.toBe(false);
      await expect(service.hasActiveProxyAction(pair)).resolves.toBe(true);
    });

    it('is true in any wave for a legacy grant', async () => {
      const { service } = makeService(storedAction({ wave_allowlist: null }));
      await expect(
        service.hasActiveProxyAction({ ...pair, wave_id: 'wave-2' })
      ).resolves.toBe(true);
    });

    it.each([
      ['revoked', { revoked_at: 3 }],
      ['expired', { end_time: Time.currentMillis() - 1 }],
      ['not yet accepted', { accepted_at: null }]
    ])(
      'is false for a %s grant even in a listed wave',
      async (_label, state) => {
        const { service } = makeService(
          storedAction({ wave_allowlist: ['wave-1'], ...state })
        );
        await expect(
          service.hasActiveProxyAction({ ...pair, wave_id: 'wave-1' })
        ).resolves.toBe(false);
        await expect(service.findActiveProxyAction(pair)).resolves.toBeNull();
      }
    );
  });

  describe('state changes', () => {
    it('invalidates the grantee cache on accept and revoke', async () => {
      const { service } = makeService(storedAction({ accepted_at: null }));
      await service.changeProfileProxyActionStatus({
        proxy_id: PROXY.id,
        action_id: 'action-1',
        acceptance_type: 'ACCEPT' as any,
        profile_id: 'grantee'
      });
      expect(invalidate).toHaveBeenCalledTimes(1);

      const revoking = makeService(storedAction());
      await revoking.service.changeProfileProxyActionStatus({
        proxy_id: PROXY.id,
        action_id: 'action-1',
        acceptance_type: 'REVOKE' as any,
        profile_id: 'grantor'
      });
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(revoking.db.revokeProfileProxyAction).toHaveBeenCalled();
    });
  });
});
