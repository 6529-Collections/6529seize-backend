/** Schema registry types retained until explicit second-chunk physical retirement. */
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
