import { legacyCompetitionId } from '@/competitions/competition-id';
import type { MigrationStatus } from '@/competitions/competition-migration.repository';
import { parseMigrationLambdaInput } from './migration-input';
import {
  executeMigrationLambdaInput,
  type MigrationLambdaService
} from './migration-runner';

const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const id = legacyCompetitionId(waveId);
const initialNow = 1900000000000;
const live = { wave_id: waveId };

function fixture() {
  let now = initialNow;
  let native = false;
  const migration = {
    state: 'SHADOWING',
    exceptions: [],
    source_watermark: 0,
    applied_watermark: 0,
    next_batch_at: null,
    stage: 'VOTES',
    stage_offset: 0,
    consecutive_full_windows: 0
  };
  const status = () =>
    ({
      competitionId: id,
      waveId,
      storageMode: native ? 'NATIVE' : 'LEGACY_ADAPTER',
      executionMode: 'ACTIVE',
      migration,
      readiness: null,
      completedEffects: 0
    }) as unknown as MigrationStatus;
  const service = {
    inspectWave: jest.fn(async () => ({
      status: status(),
      failures: [],
      cohort: 'COMPLETED_ORDINARY',
      windowMs: 60000
    })),
    status: jest.fn(async () => status()),
    enroll: jest.fn(async () => status()),
    backfill: jest.fn(async () => status()),
    catchUp: jest.fn(async () => status()),
    resumeMigration: jest.fn(async () => status()),
    compare: jest.fn(async () => ({
      source: 'direct-legacy-sql-vs-native-tables-v1',
      independent: true,
      complete: true,
      watermark: 0,
      mismatches: 0,
      sourceFailures: [],
      categories: [],
      consecutiveFullWindows: Math.min(
        7,
        Math.floor((now - initialNow) / 60000)
      )
    })),
    readiness: jest.fn(async () => ({ failures: [] })),
    cutover: jest.fn(
      async (_id: string, _operator: unknown, dryRun: boolean) => {
        if (!dryRun) native = true;
        return { changed: !dryRun, failures: [] };
      }
    ),
    verifyNative: jest.fn(async () => ({ failures: [] })),
    recordEnvironmentAcceptance: jest.fn(),
    reverseReconcile: jest.fn(),
    rollback: jest.fn(),
    recordException: jest.fn(),
    reviewRepair: jest.fn()
  } as unknown as jest.Mocked<MigrationLambdaService>;
  const runtime = {
    environment: 'production' as const,
    now: () => now,
    remainingTime: () => 900000,
    wait: jest.fn(async (ms: number) => {
      now += ms;
    }),
    progress: jest.fn(),
    continueMigration: jest.fn().mockResolvedValue(undefined)
  };
  return {
    service,
    runtime,
    migration,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe('automatic wave migration', () => {
  it('migrates with only a wave ID and no timed waiting', async () => {
    const { service, runtime } = fixture();
    expect(
      await executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).toMatchObject({ outcome: 'COMPLETE', status: { storageMode: 'NATIVE' } });
    expect(runtime.wait).not.toHaveBeenCalled();
    expect(runtime.continueMigration).not.toHaveBeenCalled();
    expect(service.cutover.mock.calls.map((call) => call[2])).toEqual([false]);
  });
  it('continues from saved checkpoints with the original deadline', async () => {
    const { service, runtime, advance } = fixture();
    service.compare.mockImplementationOnce(async () => {
      advance(720000);
      return {
        source: 'direct-legacy-sql-vs-native-tables-v1',
        independent: true,
        complete: true,
        watermark: 0,
        consecutiveFullWindows: 0,
        mismatches: 0,
        sourceFailures: [],
        categories: []
      } as Awaited<ReturnType<MigrationLambdaService['compare']>>;
    });
    expect(
      await executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).toMatchObject({ outcome: 'CONTINUING', continuationQueued: true });
    expect(service.cutover).not.toHaveBeenCalled();
    const next = parseMigrationLambdaInput(
      runtime.continueMigration.mock.calls[0][0]
    );
    expect(next.continuation?.started_at).toBe(initialNow);
    expect(
      await executeMigrationLambdaInput(next, service, runtime)
    ).toMatchObject({ outcome: 'COMPLETE' });
  });
  it('rejects forged deadline extensions and refuses expired continuations before mutation', async () => {
    const { service, runtime } = fixture();
    const continuation = {
      run_id: waveId,
      started_at: initialNow - 60000,
      deadline_at: initialNow - 1
    };
    expect(
      await executeMigrationLambdaInput(
        parseMigrationLambdaInput({ ...live, continuation }),
        service,
        runtime
      )
    ).toMatchObject({ outcome: 'PAUSED', reason: 'TIME_BUDGET' });
    expect(service.inspectWave).not.toHaveBeenCalled();
    await expect(
      executeMigrationLambdaInput(
        parseMigrationLambdaInput({
          ...live,
          continuation: { ...continuation, deadline_at: initialNow + 172800000 }
        }),
        service,
        runtime
      )
    ).rejects.toThrow('deadline');
    expect(service.cutover).not.toHaveBeenCalled();
  });
  it('reserves Lambda cleanup time and never starts work without a budget', async () => {
    const { service, runtime } = fixture();
    runtime.remainingTime = () => 59000;
    expect(
      await executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).toMatchObject({ outcome: 'PAUSED' });
    expect(service.inspectWave).not.toHaveBeenCalled();
    expect(runtime.continueMigration).not.toHaveBeenCalled();
  });
  it('stops on comparison mismatch and records owned data-shape exceptions', async () => {
    const { service, runtime } = fixture();
    service.compare.mockResolvedValueOnce({
      source: 'direct-legacy-sql-vs-native-tables-v1',
      independent: true,
      complete: true,
      watermark: 0,
      mismatches: 1,
      sourceFailures: [],
      categories: [],
      consecutiveFullWindows: 0
    } as Awaited<ReturnType<MigrationLambdaService['compare']>>);
    await expect(
      executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).rejects.toThrow('comparison failed');
    expect(runtime.continueMigration).not.toHaveBeenCalled();
    expect(service.cutover).not.toHaveBeenCalled();
    service.compare.mockRejectedValueOnce(
      new Error('OWNED_EXCEPTION: unsupported archive shape')
    );
    await expect(
      executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).rejects.toThrow('OWNED_EXCEPTION');
    expect(service.recordException).toHaveBeenCalledWith(
      id,
      {
        actor: 'competitionMigrationLoop',
        reason: 'AWS invocation requested wave migration'
      },
      'MIGRATION_DATA_SHAPE'
    );
  });
  it('surfaces continuation publication failure without erasing checkpoints', async () => {
    const { service, runtime, advance } = fixture();
    service.compare.mockImplementationOnce(async () => {
      advance(720000);
      return {
        source: 'direct-legacy-sql-vs-native-tables-v1',
        independent: true,
        complete: true,
        watermark: 0,
        consecutiveFullWindows: 0,
        mismatches: 0,
        sourceFailures: [],
        categories: []
      } as Awaited<ReturnType<MigrationLambdaService['compare']>>;
    });
    runtime.continueMigration.mockRejectedValueOnce(
      new Error('continuation unavailable')
    );
    await expect(
      executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).rejects.toThrow('continuation unavailable');
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.cutover).not.toHaveBeenCalled();
  });
});
