import { ProfileProxiesMapper } from './proxies.mapper';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';

describe('ProfileProxiesMapper', () => {
  const mapper = new ProfileProxiesMapper({
    getOverviewsByIds: jest.fn().mockResolvedValue({
      grantor: { id: 'grantor', handle: 'grantor' },
      grantee: { id: 'grantee', handle: 'grantee' }
    })
  } as any);

  function action(
    overrides: Partial<{
      id: string;
      action_type: ProfileProxyActionType;
      wave_allowlist: string[] | null;
    }>
  ) {
    return {
      id: 'action-1',
      proxy_id: 'proxy-1',
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

  it('exposes the wave allowlist of each action, null for legacy grants', async () => {
    const [proxy] = await mapper.profileProxyEntitiesToApiProfileProxies({
      profileProxyEntities: [
        {
          id: 'proxy-1',
          target_id: 'grantee',
          created_by: 'grantor',
          created_at: 1
        }
      ],
      actions: [
        action({ id: 'scoped', wave_allowlist: ['wave-1', 'wave-2'] }),
        action({ id: 'legacy' }),
        action({
          id: 'read',
          action_type: ProfileProxyActionType.READ_WAVE
        })
      ]
    });
    expect(proxy.actions).toEqual([
      expect.objectContaining({
        id: 'scoped',
        action_type: ApiProfileProxyActionType.CreateDropToWave,
        wave_allowlist: ['wave-1', 'wave-2']
      }),
      expect.objectContaining({ id: 'legacy', wave_allowlist: null }),
      expect.objectContaining({
        id: 'read',
        action_type: ApiProfileProxyActionType.ReadWave,
        wave_allowlist: null
      })
    ]);
  });
});
