import { randomUUID } from 'node:crypto';
import type { CompetitionMigrationService } from '@/competitions/competition-migration.service';
import { legacyCompetitionId } from '@/competitions/competition-id';
import {
  migrateWave,
  WaveMigrationPausedError,
  type WaveMigrationService
} from '@/competitions/wave-migration';
import type {
  MigrationContinuation,
  MigrationLambdaInput,
  RemoteMigrationEnvironment
} from './migration-input';

export type MigrationLambdaService = WaveMigrationService &
  Pick<CompetitionMigrationService, 'recordException'>;
export type MigrationLambdaRuntime = {
  readonly environment: RemoteMigrationEnvironment;
  readonly now: () => number;
  readonly remainingTime: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly progress: (message: string) => void;
  readonly continueMigration: (input: MigrationLambdaInput) => Promise<void>;
};
const CLEANUP_RESERVE_MS = 60000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const INVOCATION_MS = 12 * 60 * 1000;
const operator = {
  actor: 'competitionMigrationLoop',
  reason: 'AWS invocation requested wave migration'
};

function continuation(
  input: MigrationLambdaInput,
  now: number
): MigrationContinuation {
  const run = input.continuation ?? {
    run_id: randomUUID(),
    started_at: now,
    deadline_at: now + MAX_DURATION_MS
  };
  if (
    run.started_at > now ||
    run.deadline_at <= run.started_at ||
    run.deadline_at - run.started_at > MAX_DURATION_MS
  )
    throw new Error('Invalid migration continuation deadline');
  return run;
}

async function runMigration(
  input: MigrationLambdaInput,
  service: MigrationLambdaService,
  runtime: MigrationLambdaRuntime
) {
  const run = continuation(input, runtime.now());
  const sliceDeadline = Math.min(
    run.deadline_at,
    runtime.now() + INVOCATION_MS,
    runtime.now() + Math.max(0, runtime.remainingTime() - CLEANUP_RESERVE_MS)
  );
  if (sliceDeadline <= runtime.now())
    return {
      outcome: 'PAUSED',
      run,
      reason: 'TIME_BUDGET',
      continuationQueued: false
    };
  const result = await runMigrationSlice(
    input,
    service,
    runtime,
    sliceDeadline
  );
  if (result)
    return { outcome: 'COMPLETE', run, continuationQueued: false, ...result };
  // Queue only clean budget pauses. Gate failures and parity mismatches propagate.
  const status = await service.status(legacyCompetitionId(input.wave_id));
  const queued = runtime.now() < run.deadline_at;
  if (queued) await runtime.continueMigration({ ...input, continuation: run });
  return {
    outcome: queued ? 'CONTINUING' : 'PAUSED',
    run,
    continuationQueued: queued,
    status
  };
}

async function runMigrationSlice(
  input: MigrationLambdaInput,
  service: MigrationLambdaService,
  runtime: MigrationLambdaRuntime,
  deadline: number
) {
  try {
    return await migrateWave(
      {
        waveId: input.wave_id,
        environment: runtime.environment,
        operator,
        dryRun: false,
        batch: 25,
        timeoutMs: Math.max(1, deadline - runtime.now())
      },
      service,
      {
        now: runtime.now,
        progress: runtime.progress,
        aborted: () =>
          runtime.now() >= deadline ||
          runtime.remainingTime() <= CLEANUP_RESERVE_MS,
        wait: (ms) =>
          runtime.wait(Math.min(ms, Math.max(0, deadline - runtime.now())))
      }
    );
  } catch (error) {
    if (error instanceof WaveMigrationPausedError) return null;
    throw error;
  }
}

export async function executeMigrationLambdaInput(
  input: MigrationLambdaInput,
  service: MigrationLambdaService,
  runtime: MigrationLambdaRuntime
): Promise<unknown> {
  try {
    return await runMigration(input, service, runtime);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('OWNED_EXCEPTION:')
    ) {
      const id = legacyCompetitionId(input.wave_id);
      const status = await service.status(id);
      if (status.migration)
        await service.recordException(
          id,
          operator,
          status.storageMode === 'NATIVE'
            ? 'NATIVE_MIGRATION_DATA_SHAPE'
            : 'MIGRATION_DATA_SHAPE'
        );
    }
    throw error;
  }
}
