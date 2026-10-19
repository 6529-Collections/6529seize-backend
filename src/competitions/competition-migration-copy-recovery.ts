import { createHash } from 'node:crypto';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import type { CompetitionMigrationEntity } from '@/entities/ICompetitionMigration';
import { competitionPayloadHash } from './competition-command-identity';
import { MIGRATION_CHECKPOINT_SELECT_SQL } from './competition-migration.repository';

const checkpointFingerprint = createHash('sha256')
  .update(MIGRATION_CHECKPOINT_SELECT_SQL)
  .digest('hex');

type CopyTimeout = SqlExecutionBudgetExceededError & {
  readonly migrationStatementNumber: number;
  readonly migrationStatementFingerprint: string;
};

/** Only application work known not to have sent COMMIT can be retried. The
 * destroyed physical connection and reacquired owner fence establish rollback;
 * the caller must also verify every saved copy field before redoing data work. */
export function isRolledBackCopyTimeout(error: unknown): error is CopyTimeout {
  if (!(error instanceof SqlExecutionBudgetExceededError)) return false;
  const context = error as Partial<CopyTimeout>;
  return (
    error.code === 'SQL_BUDGET_EXCEEDED' &&
    error.phase === 'WORK' &&
    error.commitOutcome === 'NOT_SENT' &&
    error.connectionDestroyed === true &&
    Number.isSafeInteger(context.migrationStatementNumber) &&
    Number(context.migrationStatementNumber) > 0 &&
    typeof context.migrationStatementFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(context.migrationStatementFingerprint)
  );
}

/** Before the first checkpoint is visible, only this exact read is eligible.
 * Its only preceding application statement locks the competition owner. No
 * batch claim, data mutation or audit has started. Restart from fresh durable
 * state under a new legacy-active owner fence; never rewind a peer's progress. */
export function isInitialCheckpointReadTimeout(error: unknown): boolean {
  return (
    isRolledBackCopyTimeout(error) &&
    error.migrationStatementNumber === 2 &&
    error.migrationStatementFingerprint === checkpointFingerprint
  );
}

/** Capture watermarks/updated_at may advance from live legacy writes. Every
 * saved copy field must still match when ownership is reacquired for a retry. */
export function migrationCopyCheckpoint(
  migration: CompetitionMigrationEntity
): string {
  return competitionPayloadHash({
    state: migration.state,
    stage: migration.stage,
    offset: migration.stage_offset,
    cursor: migration.stage_cursor,
    claim: migration.next_batch_at,
    completed: migration.completed_stages,
    reset: migration.reset_table_index,
    target: migration.target_watermark,
    applied: migration.applied_watermark,
    cutover: migration.cutover_at
  });
}
