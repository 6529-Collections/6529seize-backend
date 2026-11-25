import { WaveMetadataApiService } from '@/api/waves/wave-metadata.api.service';
import { Time } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const FLAG = 'FEATURE_WAVES_FROZEN';
const AT = 'WAVES_FREEZE_AT';
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

// Every wave moves unless a test says otherwise.
beforeEach(() => {
  stubWavesScope();
});

describe('wave metadata during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of [FLAG, AT]) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of [FLAG, AT]) delete process.env[name];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of [FLAG, AT]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
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

  it('checks again right before the write when the freeze starts meanwhile', async () => {
    const freeze = Date.UTC(2026, 10, 25);
    process.env[AT] = new Date(freeze).toISOString();
    const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(freeze - 1);
    const { service, waveMetadataDb } = createService();
    // The access check is the wait between the early check and the write.
    jest
      .spyOn(service as any, 'assertCanManageWaveMetadata')
      .mockImplementation(async () => {
        now.mockReturnValue(freeze + 1);
      });
    await expect(
      service.create({ waveId: 'w', dataKey: 'k', dataValue: 'v' }, {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    now.mockReturnValue(freeze - 1);
    await expect(
      service.delete({ waveId: 'w', metadataId: 1 }, {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(waveMetadataDb.create).not.toHaveBeenCalled();
    expect(waveMetadataDb.deleteByIdAndWaveId).not.toHaveBeenCalled();
  });
});
