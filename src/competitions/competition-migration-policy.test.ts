import fc from 'fast-check';
import {
  assertMigrationRollbackSafe,
  migrationReadinessFailures,
  MigrationReadiness,
  MIGRATION_STAGES,
  nextMigrationWindowStreak
} from './competition-migration-policy';

const now = 100000;
function ready(): MigrationReadiness {
  return {
    state: 'SHADOWING',
    owner: 'fixture-owner',
    sourceWatermark: 7,
    appliedWatermark: 7,
    completedStages: [...MIGRATION_STAGES],
    consecutiveFullWindows: 7,
    lastComparisonAt: now,
    lastComparisonWatermark: 7,
    currentAcceptanceMatches: true,
    captureHealthy: true,
    compatibilityEnabled: true,
    windowDurationMs: 60000,
    pendingEffects: 0,
    nativeDecisionsSinceCutover: 0,
    unresolvedExceptions: [],
    acceptance: {
      productionEvidenceVerifiedBy: 'fixture-owner',
      productionEvidenceVerifiedAt: now,
      comparisonWindowMs: 60000,
      nativeRankCompletion: 'fixture:rank',
      nativeApproveCompletion: 'fixture:approve',
      operationalAcceptance: 'fixture:ops',
      compatibilityAcceptance: 'fixture:compatibility',
      rollbackRehearsal: 'fixture:rollback',
      alertsVerified: 'fixture:alerts',
      serviceRevisions: Object.fromEntries(
        [
          'api',
          'waveDecisionExecutionLoop',
          'waveLeaderboardSnapshotterLoop',
          'tdhLoop'
        ].map((service) => [service, 'a'.repeat(40)])
      ),
      apiBaselineP95: 100,
      apiP95: 125,
      apiBudgetP95: 150,
      apiBaselineErrorRate: 0,
      apiErrorRate: 0,
      decisionBudgetP95: 60,
      decisionBudgetP99: 120,
      decisionP95: 50,
      decisionP99: 110,
      incidentWindowStartsAt: now - 1000,
      incidentWindowEndsAt: now + 1000
    }
  };
}

describe('per-competition migration gates', () => {
  it('uses real local parity without production evidence or elapsed production windows', () => {
    const local = {
      ...ready(),
      consecutiveFullWindows: 0,
      lastComparisonMatches: true,
      acceptance: {
        ...ready().acceptance,
        productionEvidenceVerifiedBy: null,
        nativeRankCompletion: null
      }
    };
    expect(migrationReadinessFailures(local, now, 'local')).toEqual([]);
    expect(migrationReadinessFailures(local, now, 'production')).toEqual(
      expect.arrayContaining([
        'SEVEN_FULL_INDEPENDENT_WINDOWS',
        'VERIFIED_PRODUCTION_EVIDENCE',
        'EVIDENCE_nativeRankCompletion'
      ])
    );
    expect(
      migrationReadinessFailures(
        { ...local, lastComparisonMatches: false },
        now,
        'local'
      )
    ).toContain('FULL_INDEPENDENT_COMPARISON');
    expect(
      migrationReadinessFailures(
        {
          ...local,
          captureHealthy: false,
          sourceWatermark: 8,
          pendingEffects: 1
        },
        now,
        'local'
      )
    ).toEqual(
      expect.arrayContaining([
        'DURABLE_CAPTURE',
        'CATCH_UP_LAG',
        'OUTBOX_BACKLOG'
      ])
    );
  });
  it('requires every production acceptance gate independently', () => {
    expect(migrationReadinessFailures(ready(), now)).toEqual([]);
    const missing = ready();
    expect(
      migrationReadinessFailures(
        {
          ...missing,
          acceptance: {
            ...missing.acceptance,
            nativeRankCompletion: null,
            operationalAcceptance: null,
            apiBaselineP95: null,
            decisionBudgetP99: null
          }
        },
        now
      )
    ).toEqual(
      expect.arrayContaining([
        'EVIDENCE_nativeRankCompletion',
        'EVIDENCE_operationalAcceptance',
        'API_P95',
        'DECISION_P99'
      ])
    );
  });
  it.each([
    'STATE',
    'DURABLE_CAPTURE',
    'CATCH_UP_LAG',
    'BACKFILL_INCOMPLETE',
    'SEVEN_FULL_INDEPENDENT_WINDOWS',
    'CURRENT_ENVIRONMENT_ACCEPTANCE',
    'FINAL_PARITY_WATERMARK',
    'OUTBOX_BACKLOG',
    'OWNED_EXCEPTIONS'
  ])('blocks %s', (gate) => {
    const invalid: Record<string, Partial<MigrationReadiness>> = {
      STATE: { state: 'BACKFILLING' },
      DURABLE_CAPTURE: { captureHealthy: false },
      CATCH_UP_LAG: { sourceWatermark: 8 },
      BACKFILL_INCOMPLETE: { completedStages: [] },
      SEVEN_FULL_INDEPENDENT_WINDOWS: { consecutiveFullWindows: 6 },
      CURRENT_ENVIRONMENT_ACCEPTANCE: { currentAcceptanceMatches: false },
      FINAL_PARITY_WATERMARK: { lastComparisonWatermark: 6 },
      OUTBOX_BACKLOG: { pendingEffects: 1 },
      OWNED_EXCEPTIONS: {
        unresolvedExceptions: ['owner: privileged cohort not approved']
      }
    };
    expect(
      migrationReadinessFailures({ ...ready(), ...invalid[gate] }, now)
    ).toContain(gate);
  });
  it('never counts self-comparison, incomplete or mismatch windows', () => {
    fc.assert(
      fc.property(
        fc.nat(100),
        fc.integer({ min: 1, max: 100 }),
        (previousStreak, mismatches) => {
          const input = {
            previousStreak,
            previousWindowEnd: 10,
            windowStart: 10,
            windowEnd: 20,
            complete: true,
            independent: true,
            mismatches: 0
          };
          expect(nextMigrationWindowStreak(input)).toBe(previousStreak + 1);
          expect(nextMigrationWindowStreak({ ...input, mismatches })).toBe(0);
          expect(
            nextMigrationWindowStreak({ ...input, independent: false })
          ).toBe(0);
          expect(nextMigrationWindowStreak({ ...input, complete: false })).toBe(
            0
          );
          expect(nextMigrationWindowStreak({ ...input, windowStart: 9 })).toBe(
            previousStreak
          );
        }
      )
    );
  });
  it('never offers a blind rollback after a native decision or any effect', () => {
    expect(() => assertMigrationRollbackSafe(ready(), 0)).not.toThrow();
    expect(() =>
      assertMigrationRollbackSafe(
        { nativeDecisionsSinceCutover: 1, pendingEffects: 0 },
        0
      )
    ).toThrow('ROLLBACK_REQUIRED');
    expect(() =>
      assertMigrationRollbackSafe(
        { nativeDecisionsSinceCutover: 0, pendingEffects: 1 },
        0
      )
    ).toThrow('ROLLBACK_REQUIRED');
    expect(() => assertMigrationRollbackSafe(ready(), 1)).toThrow(
      'ROLLBACK_REQUIRED'
    );
  });
});
