import { CompetitionExecutionRouter } from '@/competitions/competition-execution.router';
import {
  CompetitionExecutionMode,
  CompetitionStorageMode
} from '@/entities/ICompetition';

describe('CompetitionExecutionRouter', () => {
  const features = {
    isNativeCompetitionExecutionEnabled: jest.fn().mockReturnValue(false)
  };
  const repository = {
    listCompetitionRecordsForWave: jest.fn()
  };
  const router = new CompetitionExecutionRouter(
    repository as never,
    features as never
  );

  beforeEach(() => jest.clearAllMocks());

  it('keeps legacy execution active while an additive mapping is absent', async () => {
    repository.listCompetitionRecordsForWave.mockResolvedValue([]);
    await expect(
      router.shouldUseLegacyWaveExecution('wave-a', {})
    ).resolves.toBe(true);
  });

  it('requires the immutable legacy primary to own active execution', async () => {
    repository.listCompetitionRecordsForWave.mockResolvedValue([
      {
        id: 'competition-a',
        wave_id: 'wave-a',
        legacy_wave_id: 'wave-a',
        storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
        execution_mode: CompetitionExecutionMode.ACTIVE
      },
      {
        id: 'competition-b',
        wave_id: 'wave-a',
        legacy_wave_id: null,
        storage_mode: CompetitionStorageMode.NATIVE,
        execution_mode: CompetitionExecutionMode.ACTIVE
      }
    ]);
    await expect(
      router.shouldUseLegacyWaveExecution('wave-a', {})
    ).resolves.toBe(true);
  });

  it('never allows native execution while the global kill switch is off', () => {
    expect(
      router.isNativeExecutionAllowed({
        storage_mode: CompetitionStorageMode.NATIVE,
        execution_mode: CompetitionExecutionMode.ACTIVE
      })
    ).toBe(false);
  });
});
