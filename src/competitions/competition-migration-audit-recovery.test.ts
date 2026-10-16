import { createHash } from 'node:crypto';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import type { CompetitionMigrationEntity } from '@/entities/ICompetitionMigration';
import { MIGRATION_AUDIT_INSERT_SQL } from './competition-migration.repository';
import {
  isRolledBackCopyAuditTimeout,
  migrationCopyCheckpoint
} from './competition-migration-audit-recovery';

function auditTimeout() {
  return Object.assign(
    new SqlExecutionBudgetExceededError(
      'SQL_BUDGET_EXCEEDED',
      'WORK',
      'NOT_SENT'
    ),
    {
      connectionDestroyed: true,
      migrationStatementFingerprint: createHash('sha256')
        .update(MIGRATION_AUDIT_INSERT_SQL)
        .digest('hex')
    }
  );
}

describe('copy audit timeout recovery eligibility', () => {
  it('recognizes only the known audit insert with a destroyed uncommitted connection', () => {
    expect(isRolledBackCopyAuditTimeout(auditTimeout())).toBe(true);
  });
  it.each([
    { code: 'SQL_STATEMENT_FAILED' },
    { phase: 'COMMIT' },
    { commitOutcome: 'UNKNOWN' },
    { commitOutcome: 'ACKNOWLEDGED' },
    { connectionDestroyed: false },
    { migrationStatementFingerprint: 'different-statement' },
    { migrationStatementFingerprint: undefined }
  ])('rejects an unsafe or unrelated failure: %j', (change) => {
    expect(
      isRolledBackCopyAuditTimeout(Object.assign(auditTimeout(), change))
    ).toBe(false);
  });
  it('does not trust serialized, wrapped or arbitrary errors', () => {
    for (const error of [
      { ...auditTimeout() },
      { driverError: auditTimeout() },
      new Error('timeout'),
      null
    ])
      expect(isRolledBackCopyAuditTimeout(error)).toBe(false);
  });
});

describe('saved copy checkpoint guard', () => {
  const source = {
    state: 'BACKFILLING',
    stage: 'VOTERS',
    stage_offset: 0,
    stage_cursor: '["drop","voter"]',
    completed_stages: ['CONFIGURATION', 'ENTRIES'],
    reset_table_index: null,
    target_watermark: 10,
    applied_watermark: 5,
    cutover_at: null,
    source_watermark: 12,
    updated_at: 100
  } as CompetitionMigrationEntity;

  it('permits capture-only progress from live legacy activity', () => {
    expect(
      migrationCopyCheckpoint({
        ...source,
        source_watermark: 20,
        updated_at: 200
      })
    ).toBe(migrationCopyCheckpoint(source));
  });
  it.each([
    { state: 'SHADOWING' },
    { stage: 'VOTES' },
    { stage_offset: 1 },
    { stage_cursor: '["later-drop","voter"]' },
    { completed_stages: ['CONFIGURATION'] },
    { reset_table_index: 1 },
    { target_watermark: 11 },
    { applied_watermark: 6 },
    { cutover_at: 200 }
  ] as Partial<CompetitionMigrationEntity>[])(
    'detects every changed saved copy field: %j',
    (change) => {
      expect(migrationCopyCheckpoint({ ...source, ...change })).not.toBe(
        migrationCopyCheckpoint(source)
      );
    }
  );
});
