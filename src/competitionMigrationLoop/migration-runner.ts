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
  MigrationLambdaInput
} from './migration-input';

export type MigrationLambdaService = WaveMigrationService &
  Pick<
    CompetitionMigrationService,
    | 'recordEnvironmentAcceptance'
    | 'reverseReconcile'
    | 'rollback'
    | 'recordException'
    | 'reviewRepair'
  >;
export type MigrationLambdaRuntime = {
  readonly now: () => number;
  readonly remainingTime: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly progress: (message: string) => void;
  readonly continueMigration: (input: MigrationLambdaInput) => Promise<void>;
};
const CLEANUP_RESERVE_MS = 60000;

function continuation(
  input: MigrationLambdaInput,
  now: number
): MigrationContinuation {
  const run = input.continuation ?? {
    run_id: randomUUID(),
    started_at: now,
    deadline_at: now + input.max_duration_minutes * 60000
  };
  if (
    run.started_at > now ||
    run.deadline_at <= run.started_at ||
    run.deadline_at - run.started_at > input.max_duration_minutes * 60000
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
    runtime.now() + input.invocation_seconds * 1000,
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
  const status = await service.status(legacyCompetitionId(input.wave_id!));
  const queued = input.auto_continue && runtime.now() < run.deadline_at;
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
        waveId: input.wave_id!,
        environment: input.environment,
        operator: { actor: input.operator!, reason: input.reason! },
        dryRun: false,
        batch: input.batch,
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

async function dispatch(
  input: MigrationLambdaInput,
  service: MigrationLambdaService,
  runtime: MigrationLambdaRuntime
): Promise<unknown> {
  const operator = {
    actor: input.operator ?? 'dry-run',
    reason: input.reason ?? 'read-only inspection'
  };
  if (input.action === 'record-environment-acceptance')
    return input.live
      ? service.recordEnvironmentAcceptance(operator, input.acceptance)
      : { dryRun: true, action: input.action, environment: input.environment };
  const waveId = input.wave_id!;
  const id = legacyCompetitionId(waveId);
  switch (input.action) {
    case 'inspect':
      return service.inspectWave(waveId);
    case 'status':
      return service.status(id);
    case 'readiness':
      return service.readiness(id);
    case 'verify':
      return service.verifyNative(id);
    case 'migrate':
      return input.live
        ? runMigration(input, service, runtime)
        : service.inspectWave(waveId);
    case 'rollback':
      return service.rollback(id, operator, !input.live);
    default:
      if (!input.live)
        return {
          dryRun: true,
          action: input.action,
          status: await service.status(id)
        };
      switch (input.action) {
        case 'reverse-reconcile':
          return service.reverseReconcile(id, operator, input.batch);
        case 'record-exception':
          return service.recordException(id, operator, input.exception!);
        case 'review-repair':
          return service.reviewRepair(id, operator, input.evidence!);
      }
  }
}

export async function executeMigrationLambdaInput(
  input: MigrationLambdaInput,
  service: MigrationLambdaService,
  runtime: MigrationLambdaRuntime
): Promise<unknown> {
  try {
    return await dispatch(input, service, runtime);
  } catch (error) {
    if (
      input.live &&
      input.wave_id &&
      error instanceof Error &&
      error.message.startsWith('OWNED_EXCEPTION:')
    ) {
      const id = legacyCompetitionId(input.wave_id);
      const status = await service.status(id);
      if (status.migration)
        await service.recordException(
          id,
          {
            actor: input.operator!,
            reason: input.reason!
          },
          status.storageMode === 'NATIVE'
            ? 'NATIVE_MIGRATION_DATA_SHAPE'
            : 'MIGRATION_DATA_SHAPE'
        );
    }
    throw error;
  }
}
