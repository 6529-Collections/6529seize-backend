import { createHash } from 'node:crypto';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import type { CompetitionMigrationEntity } from '@/entities/ICompetitionMigration';
import { competitionPayloadHash } from './competition-command-identity';
import { MIGRATION_AUDIT_INSERT_SQL } from './competition-migration.repository';

const auditFingerprint = createHash('sha256')
  .update(MIGRATION_AUDIT_INSERT_SQL)
  .digest('hex');

/** Only this known copy-audit operation on an uncommitted destroyed connection
 * is eligible. Reacquiring ownership must confirm rollback has drained.
 * An unknown/acknowledged commit or any other SQL failure remains terminal. */
export function isRolledBackCopyAuditTimeout(error: unknown): boolean {
  return (
    error instanceof SqlExecutionBudgetExceededError &&
    error.code === 'SQL_BUDGET_EXCEEDED' &&
    error.phase === 'WORK' &&
    error.commitOutcome === 'NOT_SENT' &&
    error.connectionDestroyed === true &&
    'migrationStatementFingerprint' in error &&
    error.migrationStatementFingerprint === auditFingerprint
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
    completed: migration.completed_stages,
    reset: migration.reset_table_index,
    target: migration.target_watermark,
    applied: migration.applied_watermark,
    cutover: migration.cutover_at
  });
}
