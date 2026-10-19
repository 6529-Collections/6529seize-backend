import { createHash } from 'node:crypto';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import type { CompetitionMigrationEntity } from '@/entities/ICompetitionMigration';
import {
  MIGRATION_AUDIT_INSERT_SQL,
  MIGRATION_CHECKPOINT_SELECT_SQL
} from './competition-migration.repository';
import {
  isInitialCheckpointReadTimeout,
  isRolledBackCopyTimeout,
  migrationCopyCheckpoint
} from './competition-migration-copy-recovery';

function auditTimeout() {
  return Object.assign(
    new SqlExecutionBudgetExceededError(
      'SQL_BUDGET_EXCEEDED',
      'WORK',
      'NOT_SENT'
    ),
    {
      connectionDestroyed: true,
      migrationStatementNumber: 8,
      migrationStatementFingerprint: createHash('sha256')
        .update(MIGRATION_AUDIT_INSERT_SQL)
        .digest('hex')
    }
  );
}

describe('whole copy timeout recovery eligibility', () => {
  it('recognizes a diagnosed statement on a destroyed uncommitted connection', () => {
    expect(
      createHash('sha256').update(MIGRATION_AUDIT_INSERT_SQL).digest('hex')
    ).toBe('e190a66e663c6315a9cf84d564b645275b88f3af63424555630690c28356ec9d');
    expect(isRolledBackCopyTimeout(auditTimeout())).toBe(true);
  });
  it.each([
    { code: 'SQL_STATEMENT_FAILED' },
    { phase: 'COMMIT' },
    { commitOutcome: 'UNKNOWN' },
    { commitOutcome: 'ACKNOWLEDGED' },
    { connectionDestroyed: false },
    { migrationStatementFingerprint: 'different-statement' },
    { migrationStatementFingerprint: undefined },
    { migrationStatementNumber: 0 },
    { migrationStatementNumber: undefined }
  ])('rejects an unsafe or unrelated failure: %j', (change) => {
    expect(isRolledBackCopyTimeout(Object.assign(auditTimeout(), change))).toBe(
      false
    );
  });
  it('does not trust serialized, wrapped or arbitrary errors', () => {
    for (const error of [
      { ...auditTimeout() },
      { driverError: auditTimeout() },
      new Error('timeout'),
      null
    ])
      expect(isRolledBackCopyTimeout(error)).toBe(false);
  });
});

describe('initial checkpoint read recovery', () => {
  it('pins the observed read and permits it only as statement two', () => {
    const fingerprint = createHash('sha256')
      .update(MIGRATION_CHECKPOINT_SELECT_SQL)
      .digest('hex');
    expect(fingerprint).toBe(
      'bf5170846326fa70999caa0157ba639cb43bbf0b57e445cd7c6151a6a77c8497'
    );
    const error = Object.assign(auditTimeout(), {
      migrationStatementNumber: 2,
      migrationStatementFingerprint: fingerprint
    });
    expect(isInitialCheckpointReadTimeout(error)).toBe(true);
    expect(
      isInitialCheckpointReadTimeout(
        Object.assign(error, { migrationStatementNumber: 3 })
      )
    ).toBe(false);
    expect(isInitialCheckpointReadTimeout(auditTimeout())).toBe(false);
  });
  it('accepts other diagnosed statements only with the caller checkpoint guard', () => {
    expect(
      isRolledBackCopyTimeout(
        Object.assign(auditTimeout(), {
          migrationStatementFingerprint:
            'b49bb6d3b8f95c376bdd7ef9c63ff2d1b2dc95f6595ab5eb72c477fc286ea01a'
        })
      )
    ).toBe(true);
  });
});

describe('saved copy checkpoint guard', () => {
  const source = {
    state: 'BACKFILLING',
    stage: 'VOTERS',
    stage_offset: 0,
    stage_cursor: '["drop","voter"]',
    next_batch_at: 50,
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
    { next_batch_at: 100 },
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
