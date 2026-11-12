import { ProfileProxyApiService } from './proxy.api.service';
import { BadRequestException, NotFoundException } from '@/exceptions';

jest.mock('@/profileActivityLogs/profile-activity-logs.db', () => ({
  profileActivityLogsDb: { insert: jest.fn() }
}));

const GRANTOR = 'grantor-profile-id';
const TARGET = 'target-profile-id';

function setup({
  identity = { id: TARGET, handle: 'target' } as any,
  existing = null as any
} = {}) {
  const identityFetcher = {
    getIdentityAndConsolidationsByIdentityKey: jest
      .fn()
      .mockResolvedValue(identity)
  };
  const profileProxiesDb = {
    findProfileProxyByTargetTypeAndIdAndCreatedByProfileId: jest
      .fn()
      .mockResolvedValue(existing),
    executeNativeQueriesInTransaction: jest.fn((fn: any) => fn({})),
    insertProfileProxy: jest.fn(),
    findProfileProxyById: jest.fn().mockResolvedValue({ id: 'proxy-1' }),
    findProfileProxyActionsByProxyId: jest.fn().mockResolvedValue([])
  };
  const mapper = {
    profileProxyEntitiesToApiProfileProxies: jest
      .fn()
      .mockResolvedValue([{ id: 'proxy-1' }])
  };
  const service = new ProfileProxyApiService(
    identityFetcher as any,
    profileProxiesDb as any,
    mapper as any
  );
  return { service, profileProxiesDb };
}

describe('ProfileProxyApiService.createProfileProxy', () => {
  it.each(['target', '0x1111111111111111111111111111111111111111', 'x.eth'])(
    'stores the resolved profile id when the target is given as %s',
    async (targetKey) => {
      const { service, profileProxiesDb } = setup();

      await service.createProfileProxy({
        params: { target_id: targetKey },
        grantorProfileId: GRANTOR
      });

      expect(
        profileProxiesDb.findProfileProxyByTargetTypeAndIdAndCreatedByProfileId
      ).toHaveBeenCalledWith({
        target_id: TARGET,
        created_by_profile_id: GRANTOR
      });
      expect(profileProxiesDb.insertProfileProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          profileProxy: expect.objectContaining({
            target_id: TARGET,
            created_by: GRANTOR
          })
        })
      );
    }
  );

  it('rejects a target that resolves to the grantor', async () => {
    const { service, profileProxiesDb } = setup({
      identity: { id: GRANTOR, handle: 'grantor' }
    });

    await expect(
      service.createProfileProxy({
        params: { target_id: 'grantor' },
        grantorProfileId: GRANTOR
      })
    ).rejects.toThrow(
      new BadRequestException('You cannot create a proxy to yourself')
    );
    expect(profileProxiesDb.insertProfileProxy).not.toHaveBeenCalled();
  });

  it('rejects a duplicate of a proxy stored under the profile id', async () => {
    const { service, profileProxiesDb } = setup({
      existing: { id: 'existing', target_id: TARGET }
    });

    await expect(
      service.createProfileProxy({
        params: { target_id: 'target' },
        grantorProfileId: GRANTOR
      })
    ).rejects.toThrow(
      new BadRequestException('Profile proxy for target target already exists')
    );
    expect(profileProxiesDb.insertProfileProxy).not.toHaveBeenCalled();
  });

  it('rejects a target without a profile', async () => {
    const { service } = setup({ identity: { id: null, handle: null } });

    await expect(
      service.createProfileProxy({
        params: { target_id: '0x2222222222222222222222222222222222222222' },
        grantorProfileId: GRANTOR
      })
    ).rejects.toThrow(NotFoundException);
  });
});
