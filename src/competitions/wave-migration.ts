import {
  CompetitionMigrationService,
  MigrationOperator
} from './competition-migration.service';
import { MigrationEnvironment } from './competition-migration-policy';
import { MigrationStatus } from './competition-migration.repository';

export type WaveMigrationOptions = {
  waveId: string;
  environment: MigrationEnvironment;
  operator: MigrationOperator;
  dryRun: boolean;
  batch: number;
  timeoutMs: number;
};
export type WaveMigrationService = Pick<
  CompetitionMigrationService,
  | 'inspectWave'
  | 'status'
  | 'enroll'
  | 'backfill'
  | 'catchUp'
  | 'compare'
  | 'readiness'
  | 'cutover'
  | 'verifyNative'
  | 'resumeMigration'
>;
export type WaveMigrationRuntime = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  progress: (message: string) => void;
  aborted?: () => boolean;
};

/** A clean checkpoint boundary, distinct from a failed migration gate. */
export class WaveMigrationPausedError extends Error {
  constructor() {
    super(
      'Migration paused; rerun the same command to resume its saved checkpoint'
    );
    this.name = 'WaveMigrationPausedError';
    Object.setPrototypeOf(this, WaveMigrationPausedError.prototype);
  }
}

function assertHealthyStatus(status: MigrationStatus): void {
  if (status.migration?.state === 'ROLLBACK_REQUIRED')
    throw new Error('Native repair is required; ownership is retained');
  if (status.migration?.exceptions.length)
    throw new Error(
      `Migration requires adapter review: ${status.migration.exceptions.join(', ')}`
    );
}

async function verify(
  service: WaveMigrationService,
  id: string,
  progress: WaveMigrationRuntime['progress']
) {
  const verification = await service.verifyNative(id);
  if (verification.failures.length)
    throw new Error(
      `Native verification failed: ${verification.failures.join(', ')}; ownership is retained`
    );
  const status = await service.status(id);
  if (status.storageMode !== 'NATIVE' || status.executionMode !== 'ACTIVE')
    throw new Error('Native ownership verification failed');
  progress(
    'Migration complete: native ownership verified; wave and drop URLs are preserved.'
  );
  return { dryRun: false, status, verification };
}

/** Every mutation uses existing transaction fences and durable checkpoints.
 * Interruption/deadline stops between batches; a retry resumes the same primary. */
export async function migrateWave(
  options: WaveMigrationOptions,
  service: WaveMigrationService,
  runtime: WaveMigrationRuntime
) {
  const inspection = await service.inspectWave(options.waveId);
  const id = inspection.status.competitionId;
  runtime.progress(
    `Wave ${options.waveId}: competition ${id}, owner ${inspection.status.storageMode}.`
  );
  if (options.dryRun) return { dryRun: true, ...inspection };
  if (inspection.status.storageMode === 'NATIVE') {
    assertHealthyStatus(inspection.status);
    return verify(service, id, runtime.progress);
  }
  if (inspection.failures.length)
    throw new Error(
      `Environment/source is not ready: ${inspection.failures.join(', ')}`
    );
  const deadline = runtime.now() + options.timeoutMs;
  const budget = {
    ...runtime,
    aborted: () => runtime.now() >= deadline || !!runtime.aborted?.()
  };
  if (budget.aborted()) throw new WaveMigrationPausedError();
  const failedComparison =
    inspection.status.migration?.last_comparison_at != null &&
    inspection.status.readiness?.lastComparisonMatches === false;
  const resumed =
    inspection.status.migration?.exceptions.length || failedComparison
      ? await service.resumeMigration(id, options.operator)
      : inspection.status;
  assertHealthyStatus(resumed);
  if (
    !inspection.status.migration ||
    inspection.status.migration.state === 'LEGACY'
  ) {
    runtime.progress(`Enrolling in ${inspection.cohort}.`);
    await service.enroll(id, options.operator, inspection.cohort);
  }
  while (!budget.aborted()) {
    const result = await advanceMigration(
      options,
      service,
      budget,
      id,
      inspection.windowMs
    );
    if (result) return result;
  }
  throw new WaveMigrationPausedError();
}

async function advanceMigration(
  options: WaveMigrationOptions,
  service: WaveMigrationService,
  runtime: WaveMigrationRuntime,
  id: string,
  windowMs: number
) {
  const status = await service.status(id);
  if (runtime.aborted?.()) return null;
  assertHealthyStatus(status);
  if (status.storageMode === 'NATIVE')
    return verify(service, id, runtime.progress);
  const migration = status.migration;
  if (!migration) throw new Error('Migration checkpoint is missing');
  if (migration.next_batch_at && migration.next_batch_at > runtime.now()) {
    await runtime.wait(
      Math.min(30000, migration.next_batch_at - runtime.now())
    );
    return null;
  }
  if (migration.state === 'BACKFILLING') {
    runtime.progress(
      `Copying ${migration.stage} (checkpoint ${migration.stage_offset}).`
    );
    await service.backfill(id, options.operator, options.batch);
    return null;
  }
  if (migration.source_watermark !== migration.applied_watermark) {
    runtime.progress(
      `Catching up: ${migration.source_watermark - migration.applied_watermark} journal changes.`
    );
    await service.catchUp(id, options.operator, options.batch);
    return null;
  }
  const result = await compareAndCutover(
    options,
    service,
    runtime,
    id,
    windowMs
  );
  if (result) return result;
  await runtime.wait(250);
  return null;
}

async function compareAndCutover(
  options: WaveMigrationOptions,
  service: WaveMigrationService,
  runtime: WaveMigrationRuntime,
  id: string,
  windowMs: number
) {
  const comparison = await service.compare(id, options.operator, windowMs);
  if (comparison.mismatches || comparison.sourceFailures.length)
    throw new Error(
      `Independent comparison failed (${comparison.mismatches} mismatches): ${[...comparison.categories.filter((category) => category.baselineHash !== category.candidateHash).map((category) => category.category), ...comparison.sourceFailures].join(', ')}; legacy ownership is retained`
    );
  runtime.progress('Independent comparison matches.');
  const readiness = await service.readiness(id);
  if (runtime.aborted?.()) return null;
  const waiting = new Set([
    'FULL_INDEPENDENT_COMPARISON',
    'CATCH_UP_LAG',
    'FINAL_PARITY_WATERMARK',
    'OUTBOX_BACKLOG'
  ]);
  const stops = readiness.failures.filter((failure) => !waiting.has(failure));
  if (stops.length) throw new Error(`Cutover is blocked: ${stops.join(', ')}`);
  if (readiness.failures.length) {
    if (readiness.failures.includes('OUTBOX_BACKLOG'))
      runtime.progress('Waiting for pending publication receipts to complete.');
    return null;
  }
  // Live cutover runs the full comparison and invariants under its ownership
  // lock before changing storage. A duplicate dry run can expire a large copy's
  // comparison even though it matches and its watermark has not changed.
  runtime.progress('Final comparison and atomic ownership transfer.');
  const cutover = await service.cutover(id, options.operator, false);
  const cutoverStops = cutover.failures.filter(
    (failure) => !waiting.has(failure)
  );
  if (cutoverStops.length)
    throw new Error(`Final transfer is blocked: ${cutoverStops.join(', ')}`);
  if (cutover.failures.length || !cutover.changed) return null;
  return verify(service, id, runtime.progress);
}
