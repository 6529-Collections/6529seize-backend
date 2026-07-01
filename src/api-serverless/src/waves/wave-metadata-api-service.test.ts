import { AuthenticationContext } from '@/auth-context';
import { NotFoundException } from '@/exceptions';
import { WaveMetadataApiService } from './wave-metadata.api.service';

function makeWave(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wave-1',
    visibility_group_id: null,
    parent_wave_id: null,
    created_by: 'creator-profile',
    admin_group_id: null,
    ...overrides
  };
}

function createService() {
  const waveMetadataDb = {
    listByWaveId: jest.fn().mockResolvedValue([
      {
        id: 1,
        wave_id: 'wave-1',
        data_key: 'artist',
        data_value: '6529er'
      }
    ]),
    create: jest.fn().mockResolvedValue({
      id: 2,
      wave_id: 'wave-1',
      data_key: 'season',
      data_value: '1'
    }),
    deleteByIdAndWaveId: jest.fn().mockResolvedValue({
      id: 2,
      wave_id: 'wave-1',
      data_key: 'season',
      data_value: '1'
    })
  };
  const wavesApiDb = {
    findWaveById: jest.fn().mockResolvedValue(makeWave())
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };

  return {
    service: new WaveMetadataApiService(
      waveMetadataDb as any,
      wavesApiDb as any,
      userGroupsService as any
    ),
    waveMetadataDb,
    wavesApiDb,
    userGroupsService
  };
}

describe('WaveMetadataApiService', () => {
  it('lists metadata for a readable wave', async () => {
    const { service, waveMetadataDb, userGroupsService } = createService();

    await expect(service.list('wave-1', {})).resolves.toEqual([
      {
        id: 1,
        data_key: 'artist',
        data_value: '6529er'
      }
    ]);

    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(waveMetadataDb.listByWaveId).toHaveBeenCalledWith('wave-1', {});
  });

  it('does not list metadata when the wave is not readable', async () => {
    const { service, wavesApiDb, waveMetadataDb } = createService();
    wavesApiDb.findWaveById.mockResolvedValue(
      makeWave({ visibility_group_id: 'private-group' })
    );

    await expect(service.list('wave-1', {})).rejects.toThrow(NotFoundException);
    expect(waveMetadataDb.listByWaveId).not.toHaveBeenCalled();
  });

  it('lets the wave creator add metadata', async () => {
    const { service, waveMetadataDb } = createService();
    const ctx = {
      authenticationContext:
        AuthenticationContext.fromProfileId('creator-profile')
    };

    await expect(
      service.create(
        {
          waveId: 'wave-1',
          dataKey: 'season',
          dataValue: '1'
        },
        ctx
      )
    ).resolves.toEqual({
      id: 2,
      data_key: 'season',
      data_value: '1'
    });

    expect(waveMetadataDb.create).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dataKey: 'season',
        dataValue: '1'
      },
      ctx
    );
  });

  it('lets a wave admin delete metadata', async () => {
    const { service, wavesApiDb, userGroupsService, waveMetadataDb } =
      createService();
    wavesApiDb.findWaveById.mockResolvedValue(
      makeWave({ admin_group_id: 'admin-group' })
    );
    userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([
      'admin-group'
    ]);
    const ctx = {
      authenticationContext:
        AuthenticationContext.fromProfileId('admin-profile')
    };

    await expect(
      service.delete({ waveId: 'wave-1', metadataId: 2 }, ctx)
    ).resolves.toEqual({
      id: 2,
      data_key: 'season',
      data_value: '1'
    });

    expect(waveMetadataDb.deleteByIdAndWaveId).toHaveBeenCalledWith(
      2,
      'wave-1',
      ctx
    );
  });

  it('returns not found when deleting missing metadata', async () => {
    const { service, waveMetadataDb } = createService();
    waveMetadataDb.deleteByIdAndWaveId.mockResolvedValue(null);
    const ctx = {
      authenticationContext:
        AuthenticationContext.fromProfileId('creator-profile')
    };

    await expect(
      service.delete({ waveId: 'wave-1', metadataId: 99 }, ctx)
    ).rejects.toThrow(NotFoundException);
  });
});
