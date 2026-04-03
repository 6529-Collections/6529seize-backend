import { AuthenticationContext } from '@/auth-context';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { WaveSelectionsApiService } from './wave-selections.api.service';

describe('WaveSelectionsApiService', () => {
  function createService({
    wave = {
      id: 'wave-1',
      admin_group_id: 'admin-group',
      visibility_group_id: null
    },
    groups = ['admin-group'],
    selection = {
      id: 'selection-1',
      title: 'Selection 1',
      wave_id: 'wave-1',
      created_at: 1,
      updated_at: 1
    },
    drop = {
      id: 'drop-1',
      wave_id: 'wave-1'
    }
  }: {
    wave?: Record<string, unknown> | null;
    groups?: string[];
    selection?: Record<string, unknown> | null;
    drop?: Record<string, unknown> | null;
  } = {}) {
    const connection = { id: 'tx' } as any;
    const waveSelectionsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      findWaveSelectionsByWaveIds: jest
        .fn()
        .mockResolvedValue(selection ? [selection] : []),
      insertWaveSelection: jest.fn().mockResolvedValue(undefined),
      findWaveSelectionById: jest.fn().mockResolvedValue(selection),
      deleteWaveSelectionDropsBySelectionId: jest
        .fn()
        .mockResolvedValue(undefined),
      deleteWaveSelection: jest.fn().mockResolvedValue(undefined),
      upsertWaveSelectionDrop: jest.fn().mockResolvedValue(undefined),
      deleteWaveSelectionDrop: jest.fn().mockResolvedValue(undefined)
    };
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue(wave)
    };
    const dropsDb = {
      findDropById: jest.fn().mockResolvedValue(drop)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(groups)
    };

    return {
      service: new WaveSelectionsApiService(
        waveSelectionsDb as any,
        wavesApiDb as any,
        dropsDb as any,
        userGroupsService as any
      ),
      waveSelectionsDb,
      dropsDb,
      ctx: {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      } as any
    };
  }

  it('creates a selection for wave admins', async () => {
    const { service, waveSelectionsDb, ctx } = createService();

    await expect(
      service.createWaveSelection(
        'wave-1',
        { title: '  Featured  ' } as any,
        ctx
      )
    ).resolves.toEqual({
      id: expect.any(String),
      title: 'Featured'
    });

    expect(waveSelectionsDb.insertWaveSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Featured',
        wave_id: 'wave-1'
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('rejects selection updates for non-admin users', async () => {
    const { service, ctx } = createService({
      groups: ['some-other-group']
    });

    await expect(
      service.createWaveSelection('wave-1', { title: 'Featured' } as any, ctx)
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects adding a drop from another wave', async () => {
    const { service, ctx } = createService({
      drop: {
        id: 'drop-2',
        wave_id: 'wave-2'
      }
    });

    await expect(
      service.addDropToWaveSelection(
        'wave-1',
        'selection-1',
        { drop_id: 'drop-2' } as any,
        ctx
      )
    ).rejects.toThrow(BadRequestException);
  });
});
