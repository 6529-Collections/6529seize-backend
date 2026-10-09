import {
  migrateWave,
  WaveMigrationOptions,
  WaveMigrationService
} from './wave-migration';
import { MigrationStatus } from './competition-migration.repository';
import { MigrationState } from './competition-migration-policy';

const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const competitionId = 'ba04bdeb-ffaa-5055-ae25-99a7d71dac80';
const matchingComparison = {
  source: 'direct-legacy-sql-vs-native-tables-v1',
  independent: true,
  complete: true,
  watermark: 0,
  categories: [],
  mismatches: 0,
  sourceFailures: [],
  consecutiveFullWindows: 0
};
const options: WaveMigrationOptions = {
  waveId,
  environment: 'local',
  operator: { actor: 'operator', reason: 'local rehearsal' },
  dryRun: false,
  batch: 25,
  timeoutMs: 1000
};
function status(state: MigrationState = 'SHADOWING'): MigrationStatus {
  return {
    competitionId,
    waveId,
    storageMode: 'LEGACY_ADAPTER',
    executionMode: 'ACTIVE',
    readiness: null,
    completedEffects: 0,
    migration: {
      competition_id: competitionId,
      wave_id: waveId,
      cohort: 'ACTIVE_LOW_VOLUME',
      owner: 'operator',
      state,
      stage: 'ENTRIES',
      stage_offset: 1,
      source_watermark: 0,
      applied_watermark: 0,
      next_batch_at: null,
      exceptions: [],
      target_watermark: 0,
      reset_table_index: null,
      stage_cursor: null,
      reverse_checkpoint: null,
      reverse_ready: false,
      completed_stages: [],
      consecutive_full_windows: 0,
      window_started_at: null,
      window_duration_ms: null,
      window_samples: 0,
      last_window_end: null,
      last_comparison_at: null,
      last_comparison_watermark: null,
      acceptance: null,
      cutover_at: null,
      cutover_decision_count: null,
      updated_at: 10000
    }
  };
}
function fixture() {
  let now = 10000;
  const service = {
    inspectWave: jest.fn().mockResolvedValue({
      status: { ...status(), migration: null },
      cohort: 'ACTIVE_LOW_VOLUME',
      failures: [],
      windowMs: 60000
    }),
    status: jest.fn().mockResolvedValue(status()),
    enroll: jest.fn().mockResolvedValue(status()),
    backfill: jest.fn().mockResolvedValue(status()),
    catchUp: jest.fn().mockResolvedValue(status()),
    compare: jest.fn().mockResolvedValue(matchingComparison),
    readiness: jest.fn().mockResolvedValue({ failures: [] }),
    cutover: jest.fn().mockImplementation(async (_id, _operator, dryRun) => {
      if (!dryRun)
        service.status.mockResolvedValue({
          ...status('NATIVE'),
          storageMode: 'NATIVE'
        });
      return { changed: !dryRun, failures: [] };
    }),
    verifyNative: jest.fn().mockResolvedValue({ failures: [] }),
    resumeMigration: jest.fn().mockResolvedValue(status())
  } as unknown as jest.Mocked<WaveMigrationService>;
  const runtime = {
    now: () => now,
    wait: jest.fn(async (ms: number) => {
      now += ms;
    }),
    progress: jest.fn()
  };
  return { service, runtime };
}

describe('automated resumable wave migration', () => {
  it('resolves a wave once, enrolls, checks parity and transfers the same primary atomically', async () => {
    const { service, runtime } = fixture();
    const result = await migrateWave(options, service, runtime);
    expect(result.status.storageMode).toBe('NATIVE');
    expect(service.inspectWave).toHaveBeenCalledWith(waveId);
    expect(service.enroll).toHaveBeenCalledWith(
      competitionId,
      options.operator,
      'ACTIVE_LOW_VOLUME'
    );
    expect(service.cutover).toHaveBeenCalledTimes(1);
    expect(service.cutover).toHaveBeenCalledWith(
      competitionId,
      options.operator,
      false
    );
    expect(service.verifyNative).toHaveBeenCalledWith(competitionId);
  });
  it('keeps inspection read-only and reports environment blockers', async () => {
    const { service, runtime } = fixture();
    service.inspectWave.mockResolvedValue({
      status: status(),
      cohort: 'ACTIVE_LOW_VOLUME',
      failures: ['DURABLE_CAPTURE'],
      windowMs: 60000
    });
    expect(
      await migrateWave({ ...options, dryRun: true }, service, runtime)
    ).toMatchObject({
      dryRun: true,
      failures: ['DURABLE_CAPTURE']
    });
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.cutover).not.toHaveBeenCalled();
    await expect(migrateWave(options, service, runtime)).rejects.toThrow(
      'DURABLE_CAPTURE'
    );
    expect(service.enroll).not.toHaveBeenCalled();
  });
  it('retains legacy ownership when the locked final comparison rejects the copy', async () => {
    const { service, runtime } = fixture();
    service.cutover.mockResolvedValue({
      changed: false,
      failures: ['frozen_relation:drop_ranks']
    } as Awaited<ReturnType<WaveMigrationService['cutover']>>);
    await expect(migrateWave(options, service, runtime)).rejects.toThrow(
      'Final transfer is blocked: frozen_relation:drop_ranks'
    );
    expect(service.cutover).toHaveBeenCalledTimes(1);
    expect(service.cutover).toHaveBeenCalledWith(
      competitionId,
      options.operator,
      false
    );
    expect(service.verifyNative).not.toHaveBeenCalled();
    expect((await service.status(competitionId)).storageMode).toBe(
      'LEGACY_ADAPTER'
    );
  });
  it('rebuilds a failed shadow comparison when the same wave is invoked again', async () => {
    const { service, runtime } = fixture();
    const failed: MigrationStatus = {
      ...status(),
      migration: { ...status().migration!, last_comparison_at: 9999 },
      readiness: {
        lastComparisonMatches: false
      } as NonNullable<MigrationStatus['readiness']>
    };
    service.inspectWave.mockResolvedValue({
      status: failed,
      cohort: 'ACTIVE_LOW_VOLUME',
      failures: [],
      windowMs: 60000
    });
    await migrateWave(options, service, runtime);
    expect(service.resumeMigration).toHaveBeenCalledWith(
      competitionId,
      options.operator
    );
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.compare).toHaveBeenCalled();
  });
  it('resumes copying and concurrent-write catch-up without reenrollment', async () => {
    const { service, runtime } = fixture();
    service.inspectWave.mockResolvedValue({
      status: status('BACKFILLING'),
      cohort: 'ACTIVE_LOW_VOLUME',
      failures: [],
      windowMs: 60000
    });
    service.status
      .mockResolvedValueOnce(status('BACKFILLING'))
      .mockResolvedValueOnce({
        ...status(),
        migration: { ...status().migration!, source_watermark: 2 }
      });
    await migrateWave(options, service, runtime);
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.backfill).toHaveBeenCalledWith(
      competitionId,
      options.operator,
      25
    );
    expect(service.catchUp).toHaveBeenCalledWith(
      competitionId,
      options.operator,
      25
    );
  });
  it('honors durable batch delays and waits for pending effects to drain', async () => {
    const { service, runtime } = fixture();
    service.status.mockResolvedValueOnce({
      ...status(),
      migration: { ...status().migration!, next_batch_at: runtime.now() + 250 }
    });
    service.readiness.mockResolvedValueOnce({
      failures: ['OUTBOX_BACKLOG'],
      status: status()
    });
    await migrateWave(options, service, runtime);
    expect(runtime.wait.mock.calls).toEqual([[250], [250]]);
  });
  it.each([
    { mismatches: 1, sourceFailures: [] },
    { mismatches: 0, sourceFailures: ['SOURCE_CREDIT_OVERSPENT'] }
  ])(
    'never switches ownership when independent comparison fails: %j',
    async (comparison) => {
      const { service, runtime } = fixture();
      service.compare.mockResolvedValue({
        ...matchingComparison,
        ...comparison,
        consecutiveFullWindows: 0
      });
      await expect(migrateWave(options, service, runtime)).rejects.toThrow(
        'Independent comparison failed'
      );
      expect(service.cutover).not.toHaveBeenCalled();
    }
  );
  it('retains saved checkpoints on timeout or interruption', async () => {
    const { service, runtime } = fixture();
    service.readiness.mockResolvedValue({
      failures: ['OUTBOX_BACKLOG'],
      status: status()
    });
    await expect(migrateWave(options, service, runtime)).rejects.toThrow(
      'resume'
    );
    expect(service.cutover).not.toHaveBeenCalled();
    service.enroll.mockClear();
    await expect(
      migrateWave(options, service, { ...runtime, aborted: () => true })
    ).rejects.toThrow('paused');
    expect(service.enroll).not.toHaveBeenCalled();
  });
  it('honors interruption during comparison before any ownership transfer', async () => {
    const { service, runtime } = fixture();
    let aborted = false;
    service.compare.mockImplementation(async () => {
      aborted = true;
      return {
        source: 'direct-legacy-sql-vs-native-tables-v1',
        independent: true,
        complete: true,
        watermark: 0,
        categories: [],
        mismatches: 0,
        sourceFailures: [],
        consecutiveFullWindows: 0
      };
    });
    await expect(
      migrateWave(options, service, { ...runtime, aborted: () => aborted })
    ).rejects.toThrow('paused');
    expect(service.cutover).not.toHaveBeenCalled();
  });
  it('verifies an already migrated primary and never copies it back over native data', async () => {
    const { service, runtime } = fixture();
    service.inspectWave.mockResolvedValue({
      status: { ...status('NATIVE'), storageMode: 'NATIVE' },
      cohort: 'ACTIVE_LOW_VOLUME',
      failures: [],
      windowMs: 60000
    });
    service.status.mockResolvedValue({
      ...status('NATIVE'),
      storageMode: 'NATIVE'
    });
    await migrateWave(options, service, runtime);
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.backfill).not.toHaveBeenCalled();
    expect(service.cutover).not.toHaveBeenCalled();
    service.verifyNative.mockResolvedValue({
      failures: ['NATIVE_AGGREGATE_INVARIANT']
    } as Awaited<ReturnType<WaveMigrationService['verifyNative']>>);
    await expect(migrateWave(options, service, runtime)).rejects.toThrow(
      'ownership is retained'
    );
  });
});
