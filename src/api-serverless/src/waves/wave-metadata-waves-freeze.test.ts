import { WaveMetadataApiService } from '@/api/waves/wave-metadata.api.service';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';

const FLAG = 'FEATURE_WAVES_FROZEN';
const PAST_FREEZE = new Error('past the waves freeze check');

function createService() {
  const waveMetadataDb = {
    create: jest.fn(),
    deleteByIdAndWaveId: jest.fn()
  };
  const wavesApiDb = { findWaveById: jest.fn().mockRejectedValue(PAST_FREEZE) };
  const service = new WaveMetadataApiService(
    waveMetadataDb as any,
    wavesApiDb as any,
    {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    } as any
  );
  jest
    .spyOn(service as any, 'assertCanManageWaveMetadata')
    .mockRejectedValue(PAST_FREEZE);
  return { service, waveMetadataDb };
}

describe('wave metadata during the waves freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('adds and removes no wave metadata while frozen', async () => {
    process.env[FLAG] = 'true';
    const { service, waveMetadataDb } = createService();
    await expect(
      service.create({ waveId: 'w', dataKey: 'k', dataValue: 'v' }, {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    await expect(
      service.delete({ waveId: 'w', metadataId: 1 }, {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(waveMetadataDb.create).not.toHaveBeenCalled();
    expect(waveMetadataDb.deleteByIdAndWaveId).not.toHaveBeenCalled();
  });

  it('changes wave metadata as before when not frozen', async () => {
    delete process.env[FLAG];
    const { service } = createService();
    await expect(
      service.create({ waveId: 'w', dataKey: 'k', dataValue: 'v' }, {})
    ).rejects.toBe(PAST_FREEZE);
  });
});
