import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { CurationsApiService } from './curations.api.service';

describe('CurationsApiService', () => {
  function createService({
    wave = {
      id: 'wave-1',
      type: WaveType.CHAT,
      created_by: 'profile-1',
      admin_group_id: null
    },
    drop = {
      id: 'drop-1',
      wave_id: 'wave-1',
      drop_type: DropType.CHAT
    },
    eligibleGroupIds = ['community-group-1'],
    waveCurations = [
      {
        id: 'curation-1',
        wave_id: 'wave-1',
        community_group_id: 'community-group-1',
        name: 'Featured',
        created_at: 1,
        updated_at: 1
      }
    ]
  }: {
    wave?: Record<string, unknown> | null;
    drop?: Record<string, unknown> | null;
    eligibleGroupIds?: string[];
    waveCurations?: Record<string, unknown>[];
  } = {}) {
    const connection = { id: 'tx' } as any;
    const curationsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      findCommunityGroupById: jest
        .fn()
        .mockResolvedValue({ id: 'community-group-1', is_private: false }),
      findWaveCurationById: jest
        .fn()
        .mockResolvedValue(waveCurations[0] ?? null),
      findWaveCurationByName: jest.fn().mockResolvedValue(null),
      insertWaveCuration: jest.fn().mockResolvedValue(undefined),
      findWaveCurationsByWaveId: jest.fn().mockResolvedValue(waveCurations),
      findWaveCurationsForDropId: jest.fn().mockResolvedValue(waveCurations),
      upsertDropCuration: jest.fn().mockResolvedValue(undefined),
      deleteDropCuration: jest.fn().mockResolvedValue(undefined),
      deleteDropCurationsByCurationId: jest.fn().mockResolvedValue(undefined),
      deleteWaveCuration: jest.fn().mockResolvedValue(undefined)
    };
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue(wave)
    };
    const dropsDb = {
      findDropById: jest.fn().mockResolvedValue(drop)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(eligibleGroupIds)
    };

    return {
      service: new CurationsApiService(
        curationsDb as any,
        wavesApiDb as any,
        dropsDb as any,
        userGroupsService as any
      ),
      curationsDb,
      ctx: {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      } as any
    };
  }

  it('creates curations for chat waves', async () => {
    const { service, curationsDb, ctx } = createService();

    await expect(
      service.createWaveCuration(
        'wave-1',
        {
          name: '  Featured  ',
          group_id: 'community-group-1'
        } as any,
        ctx
      )
    ).resolves.toEqual(
      expect.objectContaining({
        name: 'Featured',
        wave_id: 'wave-1',
        group_id: 'community-group-1'
      })
    );

    expect(curationsDb.insertWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Featured',
        wave_id: 'wave-1',
        community_group_id: 'community-group-1'
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('allows chat drops in chat waves to be curated', async () => {
    const { service, curationsDb, ctx } = createService();

    await expect(
      service.addDropCuration(
        'drop-1',
        { curation_id: 'curation-1' } as any,
        ctx
      )
    ).resolves.toBeUndefined();

    expect(curationsDb.upsertDropCuration).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        curation_id: 'curation-1',
        curated_by: 'profile-1',
        wave_id: 'wave-1'
      },
      ctx
    );
  });

  it('removes drops from an explicitly selected curation', async () => {
    const { service, curationsDb, ctx } = createService();

    await expect(
      service.removeDropCuration(
        'drop-1',
        { curation_id: 'curation-1' } as any,
        ctx
      )
    ).resolves.toBeUndefined();

    expect(curationsDb.deleteDropCuration).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        curation_id: 'curation-1'
      },
      ctx
    );
  });

  it('rejects writes when the user is not eligible for the selected curation', async () => {
    const { service, curationsDb, ctx } = createService({
      eligibleGroupIds: []
    });

    await expect(
      service.addDropCuration(
        'drop-1',
        { curation_id: 'curation-1' } as any,
        ctx
      )
    ).rejects.toThrow(`You are not eligible to curate in this curation`);

    expect(curationsDb.upsertDropCuration).not.toHaveBeenCalled();
  });

  it('returns curations for a drop', async () => {
    const { service, ctx } = createService();

    await expect(service.findDropCurations('drop-1', ctx)).resolves.toEqual([
      expect.objectContaining({
        id: 'curation-1',
        wave_id: 'wave-1',
        group_id: 'community-group-1'
      })
    ]);
  });

  it('deletes persisted memberships when a curation is deleted', async () => {
    const { service, curationsDb, ctx } = createService();

    await expect(
      service.deleteWaveCuration('wave-1', 'curation-1', ctx)
    ).resolves.toBeUndefined();

    expect(curationsDb.deleteDropCurationsByCurationId).toHaveBeenCalledWith(
      'curation-1',
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(curationsDb.deleteWaveCuration).toHaveBeenCalledWith(
      {
        id: 'curation-1',
        wave_id: 'wave-1'
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });
});
