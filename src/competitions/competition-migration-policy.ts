/** Migration policy is separate from UI default selection and runtime flags. */
export const MIGRATION_STATES = [
  'LEGACY',
  'BACKFILLING',
  'SHADOWING',
  'READY',
  'CUTTING_OVER',
  'NATIVE',
  'ROLLBACK_REQUIRED'
] as const;
export type MigrationState = (typeof MIGRATION_STATES)[number];
export const MIGRATION_STAGES = [
  'CONFIGURATION',
  'OUTCOMES',
  'ENTRIES',
  'PAUSES',
  'DECISIONS',
  'VOTERS',
  'VOTES',
  'LEADERBOARD',
  'HISTORY',
  'ARCHIVE_VOTERS'
] as const;
export type MigrationStage = (typeof MIGRATION_STAGES)[number];
export type MigrationCohort =
  | 'COMPLETED_INTERNAL'
  | 'COMPLETED_ORDINARY'
  | 'ACTIVE_LOW_VOLUME'
  | 'COMPLEX'
  | 'PRIVILEGED';

export type MigrationEnvironment = 'local' | 'staging' | 'production';

export type MigrationAcceptance = {
  readonly productionEvidenceVerifiedBy: string | null;
  readonly productionEvidenceVerifiedAt: number | null;
  readonly comparisonWindowMs: number | null;
  readonly nativeRankCompletion: string | null;
  readonly nativeApproveCompletion: string | null;
  readonly operationalAcceptance: string | null;
  readonly compatibilityAcceptance: string | null;
  readonly rollbackRehearsal: string | null;
  readonly serviceRevisions: Readonly<Record<string, string>>;
  readonly apiBaselineP95: number | null;
  readonly apiP95: number | null;
  readonly apiBudgetP95: number | null;
  readonly apiBaselineErrorRate: number | null;
  readonly apiErrorRate: number | null;
  readonly decisionBudgetP95: number | null;
  readonly decisionBudgetP99: number | null;
  readonly decisionP95: number | null;
  readonly decisionP99: number | null;
  readonly alertsVerified: string | null;
  readonly incidentWindowStartsAt: number | null;
  readonly incidentWindowEndsAt: number | null;
};

export type MigrationReadiness = {
  readonly state: MigrationState;
  readonly owner: string;
  readonly sourceWatermark: number;
  readonly appliedWatermark: number;
  readonly completedStages: readonly MigrationStage[];
  readonly consecutiveFullWindows: number;
  readonly lastComparisonAt: number | null;
  readonly lastComparisonWatermark: number | null;
  readonly lastComparisonMatches?: boolean;
  readonly currentAcceptanceMatches?: boolean;
  readonly captureHealthy: boolean;
  readonly compatibilityEnabled: boolean;
  readonly windowDurationMs: number | null;
  readonly pendingEffects: number;
  readonly nativeDecisionsSinceCutover: number;
  readonly unresolvedExceptions: readonly string[];
  readonly acceptance: MigrationAcceptance;
};

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
function nonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

export function migrationReadinessFailures(
  status: MigrationReadiness,
  now: number
): string[] {
  const failures: string[] = [];
  const add = (condition: boolean, name: string) => {
    if (!condition) failures.push(name);
  };
  add(status.state === 'SHADOWING' || status.state === 'READY', 'STATE');
  add(status.owner.trim().length > 0, 'OWNER');
  add(status.captureHealthy, 'DURABLE_CAPTURE');
  add(status.compatibilityEnabled, 'COMPATIBLE_RUNTIME_FLAGS');
  add(status.sourceWatermark === status.appliedWatermark, 'CATCH_UP_LAG');
  add(
    MIGRATION_STAGES.every((stage) => status.completedStages.includes(stage)),
    'BACKFILL_INCOMPLETE'
  );
  add(status.lastComparisonMatches === true, 'FULL_INDEPENDENT_COMPARISON');
  add(
    status.lastComparisonAt !== null &&
      status.lastComparisonAt <= now &&
      now - status.lastComparisonAt <= 60_000,
    'FINAL_PARITY_FRESHNESS'
  );
  add(
    status.lastComparisonWatermark === status.sourceWatermark,
    'FINAL_PARITY_WATERMARK'
  );
  add(status.pendingEffects === 0, 'OUTBOX_BACKLOG');
  add(status.unresolvedExceptions.length === 0, 'OWNED_EXCEPTIONS');
  return failures;
}

export function migrationAcceptanceFailures(
  acceptance: MigrationAcceptance,
  now: number,
  windowDurationMs: number | null = acceptance.comparisonWindowMs
): string[] {
  const failures: string[] = [];
  const add = (condition: boolean, name: string) => {
    if (!condition) failures.push(name);
  };
  add(
    acceptance.comparisonWindowMs !== null &&
      acceptance.comparisonWindowMs >= 60000 &&
      windowDurationMs === acceptance.comparisonWindowMs,
    'APPROVED_FULL_WINDOW'
  );
  add(
    Boolean(acceptance.productionEvidenceVerifiedBy) &&
      acceptance.productionEvidenceVerifiedAt !== null &&
      acceptance.productionEvidenceVerifiedAt <= now &&
      now - acceptance.productionEvidenceVerifiedAt <= 86400000,
    'VERIFIED_PRODUCTION_EVIDENCE'
  );
  const evidence = acceptance;
  for (const key of [
    'nativeRankCompletion',
    'nativeApproveCompletion',
    'operationalAcceptance',
    'compatibilityAcceptance',
    'rollbackRehearsal',
    'alertsVerified'
  ] as const)
    add(Boolean(evidence[key]?.trim()), `EVIDENCE_${key}`);
  for (const service of [
    'api',
    'waveDecisionExecutionLoop',
    'waveLeaderboardSnapshotterLoop',
    'tdhLoop'
  ])
    add(
      /^[a-f0-9]{40}$/.test(evidence.serviceRevisions[service] ?? ''),
      `SERVICE_${service}`
    );
  add(
    evidence.incidentWindowStartsAt !== null &&
      evidence.incidentWindowEndsAt !== null &&
      now >= evidence.incidentWindowStartsAt &&
      now < evidence.incidentWindowEndsAt,
    'INCIDENT_WINDOW'
  );
  add(
    positive(evidence.apiBaselineP95) &&
      positive(evidence.apiP95) &&
      positive(evidence.apiBudgetP95) &&
      evidence.apiP95 <= evidence.apiBudgetP95 &&
      evidence.apiP95 <=
        evidence.apiBaselineP95 + Math.max(evidence.apiBaselineP95 * 0.1, 25),
    'API_P95'
  );
  add(
    nonnegative(evidence.apiBaselineErrorRate) &&
      nonnegative(evidence.apiErrorRate) &&
      evidence.apiBaselineErrorRate <= 1 &&
      evidence.apiErrorRate <= evidence.apiBaselineErrorRate,
    'API_ERROR_RATE'
  );
  add(
    positive(evidence.decisionBudgetP95) &&
      nonnegative(evidence.decisionP95) &&
      evidence.decisionP95 <= evidence.decisionBudgetP95,
    'DECISION_P95'
  );
  add(
    positive(evidence.decisionBudgetP99) &&
      nonnegative(evidence.decisionP99) &&
      evidence.decisionP99 <= evidence.decisionBudgetP99,
    'DECISION_P99'
  );
  return failures;
}

/** Partial, overlapping, self-comparison and stale windows never count. */
export function nextMigrationWindowStreak(input: {
  previousStreak: number;
  previousWindowEnd: number | null;
  windowStart: number;
  windowEnd: number;
  complete: boolean;
  independent: boolean;
  mismatches: number;
}): number {
  if (!input.complete || !input.independent || input.mismatches !== 0) return 0;
  if (
    input.windowEnd <= input.windowStart ||
    (input.previousWindowEnd !== null &&
      input.windowStart < input.previousWindowEnd)
  )
    return input.previousStreak;
  return input.previousStreak + 1;
}

export function assertMigrationRollbackSafe(
  status: Pick<
    MigrationReadiness,
    'nativeDecisionsSinceCutover' | 'pendingEffects'
  >,
  completedEffects: number
): void {
  if (
    status.nativeDecisionsSinceCutover ||
    status.pendingEffects ||
    completedEffects
  )
    throw new Error(
      'ROLLBACK_REQUIRED: preserve native ownership; review decisions and effects before repair or reverse reconciliation'
    );
}
