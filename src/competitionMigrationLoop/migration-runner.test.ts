import { legacyCompetitionId } from '@/competitions/competition-id';
import type { MigrationStatus } from '@/competitions/competition-migration.repository';
import { parseMigrationLambdaInput } from './migration-input';
import {
  executeMigrationLambdaInput,
  type MigrationLambdaService
} from './migration-runner';
import { migrationFixtureAcceptance } from '@/tests/fixtures/competition-migration.fixture';

const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const id = legacyCompetitionId(waveId);
const initialNow = 1900000000000;
const live = {
  environment: 'production',
  action: 'migrate',
  live: true,
  wave_id: waveId,
  operator: 'operator',
  reason: 'reviewed pilot'
};

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
    resumeNegativeVoteMigration: jest.fn(async () => status()),
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
    readiness: jest.fn(async () => ({
      failures:
        now - initialNow >= 420000 ? [] : ['SEVEN_FULL_INDEPENDENT_WINDOWS']
    })),
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

describe('remote wave migration operator', () => {
  it('keeps migration inspection read-only and never queues itself', async () => {
    const { service, runtime } = fixture();
    await executeMigrationLambdaInput(
      parseMigrationLambdaInput({ ...live, live: false }),
      service,
      runtime
    );
    expect(service.inspectWave).toHaveBeenCalledWith(waveId);
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.compare).not.toHaveBeenCalled();
    expect(runtime.continueMigration).not.toHaveBeenCalled();
  });
  it('continues across Lambda budgets without bypassing seven production windows', async () => {
    const { service, runtime } = fixture();
    let input = parseMigrationLambdaInput(live);
    const outcomes: unknown[] = [];
    for (let invocation = 0; invocation < 4; invocation++) {
      outcomes.push(await executeMigrationLambdaInput(input, service, runtime));
      if (invocation < 3) {
        expect(service.cutover).not.toHaveBeenCalled();
        input = parseMigrationLambdaInput(
          runtime.continueMigration.mock.calls[invocation][0]
        );
      }
    }
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: 'CONTINUING' }),
      expect.objectContaining({ outcome: 'CONTINUING' }),
      expect.objectContaining({ outcome: 'CONTINUING' }),
      expect.objectContaining({
        outcome: 'COMPLETE',
        status: expect.objectContaining({ storageMode: 'NATIVE' })
      })
    ]);
    expect(runtime.continueMigration).toHaveBeenCalledTimes(3);
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.cutover.mock.calls.map((call) => call[2])).toEqual([
      true,
      false
    ]);
    expect(service.verifyNative).toHaveBeenCalledWith(id);
    expect(input.continuation?.started_at).toBe(initialNow);
  });
  it('allows explicitly manual resumes without queuing continuation', async () => {
    const { service, runtime } = fixture();
    expect(
      await executeMigrationLambdaInput(
        parseMigrationLambdaInput({ ...live, auto_continue: false }),
        service,
        runtime
      )
    ).toMatchObject({ outcome: 'PAUSED', continuationQueued: false });
    expect(runtime.continueMigration).not.toHaveBeenCalled();
    expect(service.cutover).not.toHaveBeenCalled();
  });
  it('stops the chain at its original overall deadline', async () => {
    const { service, runtime } = fixture();
    expect(
      await executeMigrationLambdaInput(
        parseMigrationLambdaInput({ ...live, max_duration_minutes: 1 }),
        service,
        runtime
      )
    ).toMatchObject({ outcome: 'PAUSED', continuationQueued: false });
    expect(runtime.continueMigration).not.toHaveBeenCalled();
    expect(service.cutover).not.toHaveBeenCalled();
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
          continuation: { ...continuation, deadline_at: initialNow + 86400000 }
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
  it.each([
    'ENVIRONMENT_ACCEPTANCE_REQUIRED',
    'COMPLETED_COHORT_FIRST',
    'PRIVILEGED_PARITY_AND_EFFECTS'
  ])('retains the existing %s gate without continuation', async (failure) => {
    const { service, runtime } = fixture();
    service.inspectWave.mockResolvedValue({
      status: await service.status(id),
      failures: [failure],
      cohort: 'ACTIVE_LOW_VOLUME',
      windowMs: 60000
    });
    await expect(
      executeMigrationLambdaInput(
        parseMigrationLambdaInput(live),
        service,
        runtime
      )
    ).rejects.toThrow(failure);
    expect(service.enroll).not.toHaveBeenCalled();
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
      { actor: 'operator', reason: 'reviewed pilot' },
      'MIGRATION_DATA_SHAPE'
    );
  });
  it('surfaces continuation publication failure without erasing checkpoints', async () => {
    const { service, runtime } = fixture();
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
  it('records inline approval and exposes guarded recovery without any CLI filesystem access', async () => {
    const { service, runtime } = fixture();
    const acceptance = migrationFixtureAcceptance(initialNow);
    await executeMigrationLambdaInput(
      parseMigrationLambdaInput({
        ...live,
        wave_id: undefined,
        action: 'record-environment-acceptance',
        acceptance
      }),
      service,
      runtime
    );
    expect(service.recordEnvironmentAcceptance).toHaveBeenCalledWith(
      { actor: 'operator', reason: 'reviewed pilot' },
      acceptance
    );
    await executeMigrationLambdaInput(
      parseMigrationLambdaInput({
        ...live,
        action: 'reverse-reconcile',
        batch: 10
      }),
      service,
      runtime
    );
    expect(service.reverseReconcile).toHaveBeenCalledWith(
      id,
      { actor: 'operator', reason: 'reviewed pilot' },
      10
    );
    await executeMigrationLambdaInput(
      parseMigrationLambdaInput({ ...live, action: 'rollback', live: false }),
      service,
      runtime
    );
    expect(service.rollback).toHaveBeenCalledWith(
      id,
      { actor: 'operator', reason: 'reviewed pilot' },
      true
    );
    expect(runtime.continueMigration).not.toHaveBeenCalled();
  });
});
