import { compareMigrationContent } from '@/competitions/competition-migration-content-parity';
import { MigrationAcceptanceSchema } from './competition-migration-acceptance';
import { CompetitionMigrationEnvironmentRepository } from './competition-migration-environment.repository';
import { legacyCompetitionId } from './competition-id';
import { appFeatures } from '@/app-features';
import { migrationCommandConfiguration } from './legacy-competition-configuration';
import { LegacyCompetitionAdapter } from './legacy-competition.adapter';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { CompetitionMigrationChangeEntity } from '@/entities/ICompetitionMigration';
import { reconcileLegacyBatch } from './competition-migration-reverse';
import { LEGACY_GET_SOURCE_TABLES } from './legacy-competition-get-facade';
import { performance } from 'node:perf_hooks';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_MIGRATIONS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  CompetitionMigrationRepository,
  MigrationStatus
} from '@/competitions/competition-migration.repository';
import { CompetitionMigrationBackfill } from '@/competitions/competition-migration-backfill';
import {
  MIGRATION_STAGES,
  MigrationAcceptance,
  MigrationEnvironment,
  MigrationCohort,
  migrationReadinessFailures,
  nextMigrationWindowStreak,
  assertMigrationRollbackSafe
} from '@/competitions/competition-migration-policy';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { LegacyCompetitionBaselineRepository } from '@/competitions/legacy-competition-baseline.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { loadLegacyParityCandidate } from '@/competitions/legacy-parity-snapshot';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';
import { migrationCaptureHealthy } from '@/competitions/competition-migration-capture';
import {
  Competition,
  CompetitionSnapshot
} from '@/competitions/competition.types';
import { compareLegacyFacade } from '@/competitions/legacy-competition-facade-parity';

const SHADOW_TABLES = [
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_PAUSES_TABLE
] as const;

const PARITY_FIELDS = [
  'configuration',
  'entries',
  'votes_and_credits',
  'credit_budgets',
  'leaderboard',
  'decisions_and_winners',
  'outcomes_and_distributions',
  'pauses',
  'capabilities'
] as const satisfies readonly (keyof CompetitionSnapshot)[];
function sourceCreditOverspent(snapshot: CompetitionSnapshot): boolean {
  if (!Array.isArray(snapshot.credit_budgets))
    throw new Error('Credit parity coverage is missing');
  return snapshot.credit_budgets.some(
    (budget: { spent: number; available: number }) =>
      budget.spent > budget.available
  );
}
type MigrationRecord = NonNullable<MigrationStatus['migration']>;
function sourceMigrationCohort(competition: Competition): MigrationCohort {
  if (competition.capabilities.length) return 'PRIVILEGED';
  return competition.lifecycle === 'ENDED'
    ? 'COMPLETED_ORDINARY'
    : 'ACTIVE_LOW_VOLUME';
}
function comparisonWindowSamples(
  migration: MigrationRecord,
  reset: boolean,
  finished: boolean,
  complete: boolean,
  mismatches: number
): number {
  if (reset) return complete && mismatches === 0 ? 1 : 0;
  if (finished) return 1;
  return migration.window_samples + 1;
}
function comparisonWindowEnd(
  migration: MigrationRecord,
  now: number,
  reset: boolean,
  finished: boolean
): number | null {
  if (finished) return now;
  if (reset) return null;
  return migration.last_window_end;
}
function comparisonWindowProgress(
  migration: MigrationRecord,
  now: number,
  windowMs: number,
  complete: boolean,
  mismatches: number
) {
  const changedDuration = migration.window_duration_ms !== windowMs;
  const missedSample =
    migration.last_comparison_at !== null &&
    now - migration.last_comparison_at > windowMs;
  const reset = mismatches > 0 || !complete || changedDuration || missedSample;
  const startedAt =
    reset || migration.window_started_at === null
      ? now
      : migration.window_started_at;
  const finished =
    !reset && now - startedAt >= windowMs && migration.window_samples >= 1;
  let streak = Number(migration.consecutive_full_windows);
  if (reset) streak = 0;
  else if (finished)
    streak = nextMigrationWindowStreak({
      previousStreak: streak,
      previousWindowEnd: migration.last_window_end,
      windowStart: startedAt,
      windowEnd: now,
      complete,
      independent: true,
      mismatches
    });
  return {
    consecutive_full_windows: streak,
    window_started_at: finished ? now : startedAt,
    window_duration_ms: windowMs,
    window_samples: comparisonWindowSamples(
      migration,
      reset,
      finished,
      complete,
      mismatches
    ),
    last_window_end: comparisonWindowEnd(migration, now, reset, finished)
  };
}
export type MigrationOperator = {
  readonly actor: string;
  readonly reason: string;
};

export class CompetitionMigrationService {
  constructor(
    private readonly supplier: () => SqlExecutor = dbSupplier,
    private readonly now: () => number = Date.now,
    private readonly batchIntervalMs: number = 250,
    private readonly environment: MigrationEnvironment = 'production'
  ) {
    if (
      environment === 'local' &&
      (process.env.NODE_ENV !== 'local' ||
        !['localhost', '127.0.0.1', '::1'].includes(
          process.env.DB_HOST ?? ''
        ) ||
        !['localhost', '127.0.0.1', '::1'].includes(
          process.env.DB_HOST_READ ?? ''
        ))
    )
      throw new Error(
        'Local migration policy requires explicitly configured loopback read/write databases'
      );
  }
  private async transaction<T>(
    id: string,
    action: (
      repository: CompetitionMigrationRepository,
      ctx: RequestContext
    ) => Promise<T>
  ): Promise<T> {
    const db = this.supplier();
    return db.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const repository = new CompetitionMigrationRepository(
          () => db,
          this.environment
        );
        await repository.lock(id, ctx);
        return action(repository, ctx);
      },
      { isolationLevel: 'READ COMMITTED' }
    );
  }
  private async rateLimit(
    repository: CompetitionMigrationRepository,
    id: string,
    ctx: RequestContext
  ) {
    const status = await repository.status(id, ctx);
    if (
      status.migration?.next_batch_at &&
      status.migration.next_batch_at > this.now()
    )
      return status;
    await repository.update(
      id,
      { next_batch_at: this.now() + this.batchIntervalMs },
      ctx
    );
    return null;
  }
  public status(id: string) {
    return new CompetitionMigrationRepository(
      this.supplier,
      this.environment
    ).status(id, {});
  }

  public async inspectWave(waveId: string) {
    const repository = new CompetitionRepository(this.supplier);
    const id = legacyCompetitionId(waveId);
    const record = await repository.findCompetitionRecordById(id, {});
    if (record?.legacy_wave_id !== waveId || record.wave_id !== waveId)
      throw new Error(
        'The wave has no registered legacy primary competition; prepare the migration environment first'
      );
    const status = await this.status(id);
    if (record.storage_mode === 'NATIVE')
      return {
        status,
        cohort: 'ACTIVE_LOW_VOLUME' as const,
        failures: [],
        windowMs: 1
      };
    const competition = await new LegacyCompetitionAdapter(
      repository,
      new WavesApiDb(this.supplier),
      {}
    ).getCompetition(record, this.now());
    const cohort = sourceMigrationCohort(competition);
    migrationCommandConfiguration(competition);
    const environment = await this.environmentReadiness();
    return {
      status,
      cohort,
      failures: environment.failures,
      windowMs: environment.windowMs
    };
  }

  private async environmentReadiness() {
    const failures: string[] = [];
    if (!(await migrationCaptureHealthy(this.supplier(), {})))
      failures.push('DURABLE_CAPTURE');
    if (
      !appFeatures.isNativeCompetitionExecutionEnabled() ||
      !appFeatures.isNativeCompetitionWritesEnabled()
    )
      failures.push('COMPATIBLE_RUNTIME_FLAGS');
    return { failures, windowMs: 1 };
  }

  public async recordEnvironmentAcceptance(
    operator: MigrationOperator,
    value: unknown
  ) {
    const acceptance = this.validateAcceptance(operator, value);
    await new CompetitionMigrationEnvironmentRepository(this.supplier).record(
      this.environment,
      operator,
      acceptance,
      this.now(),
      {}
    );
    return { environment: this.environment, acceptance };
  }

  /** Retire obsolete rollout restrictions, retaining actual data/repair failures.
   * Any resumed migration must pass a fresh independent comparison. */
  public async resumeMigration(id: string, operator: MigrationOperator) {
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      if (status.storageMode !== 'LEGACY_ADAPTER' || !status.migration)
        return status;
      const retired = status.migration.exceptions.filter((exception) =>
        [
          'NEGATIVE_CREDIT_REVOCATION_ADAPTER',
          'LEGACY_SIGNED_VOTE_ADAPTER',
          'PRIVILEGED_PARITY_AND_EFFECTS',
          'COMPLEX_CAPABILITY_REHEARSAL',
          'HIGH_VOLUME_FULL_COMPARISON',
          'NATIVE_COMMAND_RULE_ADAPTER',
          'MIGRATION_DATA_SHAPE'
        ].some((restriction) => exception.startsWith(`${restriction}:`))
      );
      const failedComparison =
        status.migration.state === 'SHADOWING' &&
        status.migration.last_comparison_at !== null &&
        status.readiness?.lastComparisonMatches === false;
      if (!retired.length && !failedComparison) return status;
      const record = await repository.lock(id, ctx);
      const competition = await new LegacyCompetitionAdapter(
        new CompetitionRepository(this.supplier),
        new WavesApiDb(this.supplier),
        ctx
      ).getCompetition(record, this.now());
      migrationCommandConfiguration(competition);
      await repository.update(
        id,
        {
          exceptions: status.migration.exceptions.filter(
            (exception) => !retired.includes(exception)
          ),
          ...(failedComparison
            ? {
                state: 'BACKFILLING' as const,
                stage: 'ENTRIES' as const,
                stage_offset: 0,
                stage_cursor: null,
                next_batch_at: null,
                completed_stages: [
                  'CONFIGURATION',
                  'OUTCOMES'
                ] as MigrationRecord['completed_stages']
              }
            : {}),
          consecutive_full_windows: 0,
          window_started_at: null,
          window_samples: 0,
          last_comparison_at: null,
          last_comparison_watermark: null,
          last_window_end: null
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        failedComparison
          ? 'FAILED_COMPARISON_RESUME'
          : 'SUPPORTED_ADAPTER_RESUME',
        operator.reason,
        { retiredExceptions: retired, rebuildDerivedData: failedComparison },
        ctx
      );
      return repository.status(id, ctx);
    });
  }
  public async enroll(
    id: string,
    operator: MigrationOperator,
    cohort: MigrationCohort,
    exceptions: readonly string[] = []
  ) {
    return this.transaction(id, async (repository, ctx) => {
      if (!(await migrationCaptureHealthy(this.supplier(), ctx)))
        throw new Error('Durable capture is not installed; enrollment refused');
      const record = await repository.lock(id, ctx);
      const c = await new LegacyCompetitionAdapter(
        new CompetitionRepository(this.supplier),
        new WavesApiDb(this.supplier),
        ctx
      ).getCompetition(record, this.now());
      migrationCommandConfiguration(c);
      const guards = [...exceptions];
      await repository.enroll(record, operator.actor, cohort, guards, ctx);
      await repository.audit(
        id,
        operator.actor,
        'ENROLL',
        operator.reason,
        { cohort, exceptions: guards },
        ctx
      );
      const previous = await repository.status(id, ctx);
      if (previous.migration?.state === 'LEGACY') {
        await repository.update(
          id,
          {
            state: 'BACKFILLING',
            owner: operator.actor,
            cohort,
            stage: 'CONFIGURATION',
            stage_offset: 0,
            stage_cursor: null,
            completed_stages: [],
            reset_table_index: 0,
            target_watermark: previous.migration.source_watermark,
            applied_watermark: previous.migration.source_watermark,
            consecutive_full_windows: 0,
            last_window_end: null,
            last_comparison_at: null,
            last_comparison_watermark: null,
            window_started_at: null,
            window_samples: 0,
            acceptance: null,
            exceptions: guards,
            reverse_ready: false,
            reverse_checkpoint: null,
            cutover_at: null,
            cutover_decision_count: null,
            next_batch_at: null
          },
          ctx
        );
      }
      return repository.status(id, ctx);
    });
  }
  private async resetShadowBatch(
    id: string,
    operator: MigrationOperator,
    repository: CompetitionMigrationRepository,
    tableIndex: number,
    limit: number,
    ctx: RequestContext
  ) {
    const timerName = `${this.constructor.name}->resetShadowBatch`;
    ctx.timer?.start(timerName);
    try {
      const table = SHADOW_TABLES[tableIndex];
      if (!table) throw new Error('Invalid shadow reset checkpoint');
      const deleted = await this.supplier().execute(
        `delete from ${table} where competition_id=:id limit :limit`,
        { id, limit },
        { wrappedConnection: ctx.connection }
      );
      const complete = this.supplier().getAffectedRows(deleted) < limit;
      const next = complete ? tableIndex + 1 : tableIndex;
      await repository.update(
        id,
        { reset_table_index: next >= SHADOW_TABLES.length ? null : next },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'RESET_SHADOW_BATCH',
        operator.reason,
        { table, limit, nextTable: next },
        ctx
      );
      return repository.status(id, ctx);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  /** One bounded transaction per invocation. Reissue until SHADOWING. */
  public async backfill(id: string, operator: MigrationOperator, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Batch limit must be 1..100');
    return this.transaction(id, async (repository, ctx) => {
      const before = await repository.status(id, ctx);
      const migration = before.migration;
      if (migration?.state === 'SHADOWING') return before;
      if (!migration || migration.state !== 'BACKFILLING')
        throw new Error('Competition is not BACKFILLING');
      const limited = await this.rateLimit(repository, id, ctx);
      if (limited) return limited;
      if (migration.reset_table_index !== null)
        return this.resetShadowBatch(
          id,
          operator,
          repository,
          migration.reset_table_index,
          limit,
          ctx
        );
      const record = await repository.lock(id, ctx);
      const started = performance.now();
      const nextOffset = await new CompetitionMigrationBackfill(
        this.supplier()
      ).batch(
        record,
        migration.stage,
        migration.stage_offset,
        limit,
        this.now(),
        migration.stage_cursor,
        ctx
      );
      const stageIndex = MIGRATION_STAGES.indexOf(migration.stage);
      const completed =
        nextOffset === 0
          ? Array.from(
              new Set([...migration.completed_stages, migration.stage])
            )
          : migration.completed_stages;
      const finished =
        nextOffset === 0 && stageIndex === MIGRATION_STAGES.length - 1;
      await repository.update(
        id,
        {
          stage:
            nextOffset === 0 && !finished
              ? MIGRATION_STAGES[stageIndex + 1]
              : migration.stage,
          stage_offset: typeof nextOffset === 'number' ? nextOffset : 0,
          stage_cursor: typeof nextOffset === 'string' ? nextOffset : null,
          completed_stages: completed,
          state: finished ? 'SHADOWING' : 'BACKFILLING',
          ...(finished ? { applied_watermark: migration.target_watermark } : {})
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'BACKFILL_BATCH',
        operator.reason,
        {
          stage: migration.stage,
          offset: migration.stage_offset,
          nextOffset,
          limit,
          durationMs: Math.ceil(performance.now() - started)
        },
        ctx
      );
      return repository.status(id, ctx);
    });
  }
  /** One bounded ordered journal page; then bounded derived refresh stages.
   * Never discard capture or acknowledge a watermark before its refresh commits. */
  public async catchUp(id: string, operator: MigrationOperator, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Batch limit must be 1..100');
    return this.transaction(id, async (repository, ctx) => {
      const before = await repository.status(id, ctx),
        migration = before.migration;
      if (!migration || !['SHADOWING', 'READY'].includes(migration.state))
        throw new Error('Complete the current backfill before catch-up');
      if (migration.source_watermark === migration.applied_watermark)
        return before;
      const limited = await this.rateLimit(repository, id, ctx);
      if (limited) return limited;
      const changes =
        await this.supplier().execute<CompetitionMigrationChangeEntity>(
          `select * from ${COMPETITION_MIGRATION_CHANGES_TABLE} where competition_id=:id and watermark>:watermark order by watermark,sequence limit :limit`,
          { id, watermark: migration.target_watermark, limit },
          { wrappedConnection: ctx.connection }
        );
      if (!changes.length)
        throw new Error('Capture journal gap; ownership remains legacy');
      let expected = migration.target_watermark;
      const record = await repository.lock(id, ctx),
        backfill = new CompetitionMigrationBackfill(this.supplier());
      for (const change of changes) {
        if (Number(change.watermark) !== expected + 1)
          throw new Error('Capture journal gap; ownership remains legacy');
        await backfill.applyChange(record, change, ctx);
        expected = Number(change.watermark);
      }
      const drained = expected === migration.source_watermark;
      await repository.update(
        id,
        {
          target_watermark: expected,
          state: drained ? 'BACKFILLING' : 'SHADOWING',
          ...(drained
            ? {
                stage: 'ENTRIES',
                stage_offset: 0,
                stage_cursor: null,
                completed_stages: ['CONFIGURATION', 'OUTCOMES']
              }
            : {}),
          consecutive_full_windows: 0,
          window_started_at: null,
          window_samples: 0,
          last_window_end: null,
          last_comparison_at: null,
          last_comparison_watermark: null
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'CATCH_UP_JOURNAL_BATCH',
        operator.reason,
        {
          fromWatermark: migration.target_watermark,
          throughWatermark: expected,
          changes: changes.length,
          refreshPending: true,
          limit
        },
        ctx
      );
      return repository.status(id, ctx);
    });
  }
  public async compare(
    id: string,
    operator: MigrationOperator,
    windowMs: number
  ) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1)
      throw new Error('An approved positive comparison window is required');
    const db = this.supplier();
    return db.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const repository = new CompetitionMigrationRepository(
          () => db,
          this.environment
        );
        const record = await repository.lock(id, ctx);
        const status = await repository.status(id, ctx);
        const migration = status.migration;
        if (!migration || !['SHADOWING', 'READY'].includes(migration.state))
          throw new Error('Complete backfill before independent comparison');
        if (record.storage_mode !== 'LEGACY_ADAPTER')
          throw new Error(
            'Native-backed projection cannot be its own migration baseline'
          );
        const now = this.now();
        const baseline = await new LegacyCompetitionBaselineRepository(
          () => db
        ).getSnapshot(record, now, ctx, Number.POSITIVE_INFINITY);
        const candidate = await loadLegacyParityCandidate(
          new NativeCompetitionReader(
            new CompetitionRepository(() => db),
            ctx,
            true
          ),
          record,
          now,
          ctx,
          Number.POSITIVE_INFINITY
        );
        const categories = [
          ...PARITY_FIELDS.map((field) => ({
            category: field,
            baselineHash: competitionPayloadHash(baseline[field] ?? null),
            candidateHash: competitionPayloadHash(candidate[field] ?? null)
          })),
          ...(await compareLegacyFacade(db, id, record.wave_id, ctx)),
          ...(await compareMigrationContent(db, id, record.wave_id, ctx))
        ];
        const mismatches = categories.filter(
          (category) => category.baselineHash !== category.candidateHash
        ).length;
        const complete =
          migration.completed_stages.length === MIGRATION_STAGES.length &&
          migration.source_watermark === migration.applied_watermark &&
          !sourceCreditOverspent(baseline);
        const progress = comparisonWindowProgress(
          migration,
          now,
          windowMs,
          complete,
          mismatches
        );
        await repository.update(
          id,
          {
            state: 'SHADOWING',
            ...progress,
            last_comparison_at: now,
            last_comparison_watermark: migration.source_watermark
          },
          ctx
        );
        const report = {
          source: 'direct-legacy-sql-vs-native-tables-v1',
          independent: true,
          complete,
          sourceFailures: sourceCreditOverspent(baseline)
            ? ['SOURCE_CREDIT_OVERSPENT']
            : [],
          watermark: migration.source_watermark,
          mismatches,
          consecutiveFullWindows: progress.consecutive_full_windows,
          categories
        };
        await repository.audit(
          id,
          operator.actor,
          'INDEPENDENT_COMPARISON',
          operator.reason,
          report,
          ctx
        );
        return report;
      },
      { isolationLevel: 'REPEATABLE READ' }
    );
  }
  private async nativeInvariantFailures(
    id: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const failures: string[] = [];
    const mismatch = await this.supplier().oneOrNull<{ count: number }>(
      `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} e left join ${COMPETITION_ENTRY_RUNTIME_TABLE} r on r.entry_id=e.id and r.competition_id=e.competition_id where e.competition_id=:id and e.status='ACTIVE' and (r.entry_id is null or coalesce(r.real_time_rating,0)<>(select coalesce(sum(value),0) from ${COMPETITION_VOTES_TABLE} where competition_id=e.competition_id and entry_id=e.id))`,
      { id },
      { wrappedConnection: ctx.connection }
    );
    if (Number(mismatch?.count ?? 0))
      failures.push('NATIVE_AGGREGATE_INVARIANT');
    const orphan = await this.supplier().oneOrNull<{ count: number }>(
      `select count(*) as count from ${COMPETITION_VOTES_TABLE} v left join ${COMPETITION_ENTRIES_TABLE} e on e.id=v.entry_id and e.competition_id=v.competition_id where v.competition_id=:id and e.id is null`,
      { id },
      { wrappedConnection: ctx.connection }
    );
    if (Number(orphan?.count ?? 0)) failures.push('ORPHANED_NATIVE_VOTES');
    return failures;
  }
  public async verifyNative(id: string) {
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      const failures = await this.nativeInvariantFailures(id, ctx);
      if (status.storageMode !== 'NATIVE' || status.executionMode !== 'ACTIVE')
        failures.push('NATIVE_OWNER');
      if (!status.readiness?.captureHealthy) failures.push('CAPTURE_SCHEMA');
      if (!status.readiness?.compatibilityEnabled)
        failures.push('RUNTIME_FLAGS');
      return {
        competitionId: id,
        owner: status.storageMode,
        failures,
        pendingEffects: status.readiness?.pendingEffects ?? null,
        nativeDecisionsSinceCutover:
          status.readiness?.nativeDecisionsSinceCutover ?? null
      };
    });
  }
  public async reviewRepair(
    id: string,
    operator: MigrationOperator,
    evidence: string
  ) {
    if (!/^https:\/\/[^\s]+$/.test(evidence) || evidence.length > 2000)
      throw new Error('A reviewed repair evidence URL is required');
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      if (
        status.migration?.state !== 'ROLLBACK_REQUIRED' ||
        status.storageMode !== 'NATIVE'
      )
        throw new Error('Repair review requires guarded native ownership');
      if (status.readiness?.pendingEffects)
        throw new Error(
          'Drain pending native effects before recording repair review'
        );
      const invariantFailures = await this.nativeInvariantFailures(id, ctx);
      if (invariantFailures.length)
        throw new Error(
          'Repair review refused: native invariants remain invalid'
        );
      await repository.audit(
        id,
        operator.actor,
        'NATIVE_REPAIR_REVIEW',
        operator.reason,
        {
          evidence,
          completedEffects: status.completedEffects,
          nativeDecisions: status.readiness?.nativeDecisionsSinceCutover,
          ownershipRetained: 'NATIVE'
        },
        ctx
      );
      await repository.update(
        id,
        { state: 'NATIVE', reverse_ready: false, reverse_checkpoint: null },
        ctx
      );
      return {
        reviewRecorded: true,
        ownershipRetained: 'NATIVE',
        rollbackStillGuarded: true
      };
    });
  }
  public async recordException(
    id: string,
    operator: MigrationOperator,
    code: string
  ) {
    if (!/^[A-Z][A-Z_]{2,80}$/.test(code))
      throw new Error('Use a stable uppercase exception code');
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      if (!status.migration)
        throw new Error('Exceptions require an enrolled competition');
      const exceptions = Array.from(
        new Set([...status.migration.exceptions, `${code}:${operator.actor}`])
      );
      await repository.update(
        id,
        {
          exceptions,
          consecutive_full_windows: 0,
          ...(status.storageMode === 'NATIVE'
            ? { state: 'ROLLBACK_REQUIRED' as const }
            : {})
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'OWNED_EXCEPTION',
        operator.reason,
        { code, owner: operator.actor, ownershipRetained: status.storageMode },
        ctx
      );
      return repository.status(id, ctx);
    });
  }
  public async recordAcceptance(
    id: string,
    operator: MigrationOperator,
    value: unknown
  ) {
    const acceptance = this.validateAcceptance(operator, value);
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      if (
        !status.migration ||
        !['BACKFILLING', 'SHADOWING', 'READY'].includes(status.migration.state)
      )
        throw new Error('Acceptance requires an enrolled legacy owner');
      await new CompetitionMigrationEnvironmentRepository(this.supplier).record(
        this.environment,
        operator,
        acceptance,
        this.now(),
        ctx
      );
      await repository.update(
        id,
        {
          acceptance,
          ...(status.migration.window_duration_ms !==
          acceptance.comparisonWindowMs
            ? {
                consecutive_full_windows: 0,
                window_started_at: null,
                window_samples: 0,
                last_window_end: null
              }
            : {})
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'RECORD_ACCEPTANCE',
        operator.reason,
        { acceptance },
        ctx
      );
      return repository.status(id, ctx);
    });
  }

  private validateAcceptance(
    operator: MigrationOperator,
    value: unknown
  ): MigrationAcceptance {
    const result = MigrationAcceptanceSchema.validate(value);
    if (result.error)
      throw new Error('Acceptance record is invalid; preserve pending gates');
    const acceptance = result.value as MigrationAcceptance;
    if (
      acceptance.productionEvidenceVerifiedBy !== operator.actor ||
      acceptance.productionEvidenceVerifiedAt! > this.now()
    )
      throw new Error(
        'The recording operator must attest the reviewed production evidence'
      );
    return acceptance;
  }
  private readinessFailures(status: MigrationStatus): string[] {
    return status.readiness
      ? migrationReadinessFailures(status.readiness, this.now())
      : ['NOT_ENROLLED'];
  }

  public async readiness(id: string) {
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      return { status, failures: this.readinessFailures(status) };
    });
  }
  public async cutover(
    id: string,
    operator: MigrationOperator,
    dryRun: boolean
  ) {
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      const failures = this.readinessFailures(status);
      if (!failures.length)
        failures.push(...(await this.reverseMismatches(id, ctx)));
      if (failures.length || dryRun)
        return {
          changed: false,
          failures,
          finalWatermark: status.migration?.source_watermark ?? null
        };
      const record = await repository.lock(id, ctx);
      const config = migrationCommandConfiguration(
        await new NativeCompetitionReader(
          new CompetitionRepository(this.supplier),
          ctx,
          true
        ).getCompetition(record, this.now())
      );
      const version = Number(record.config_version) + 1;
      await this.supplier().execute(
        `insert into ${COMPETITION_CONFIG_VERSIONS_TABLE} (competition_id,version,config,created_by,created_at) values (:id,:version,:config,:actor,:now)`,
        {
          id,
          version,
          config: JSON.stringify(config),
          actor: operator.actor,
          now: this.now()
        },
        { wrappedConnection: ctx.connection }
      );
      await repository.update(id, { state: 'CUTTING_OVER' }, ctx);
      const changed = await this.supplier().execute(
        `update ${COMPETITIONS_TABLE} set storage_mode='NATIVE', execution_mode='ACTIVE',config_version=:version where id=:id and storage_mode='LEGACY_ADAPTER' and execution_mode='ACTIVE'`,
        { id, version },
        { wrappedConnection: ctx.connection }
      );
      if (this.supplier().getAffectedRows(changed) !== 1)
        throw new Error('Ownership changed; cutover transaction aborted');
      await repository.update(
        id,
        {
          state: 'NATIVE',
          cutover_at: this.now(),
          cutover_decision_count: Number(
            (
              await this.supplier().oneOrNull<{ count: number }>(
                `select count(*) as count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
                { id },
                { wrappedConnection: ctx.connection }
              )
            )?.count ?? 0
          )
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'CUTOVER',
        operator.reason,
        { finalWatermark: status.migration?.source_watermark },
        ctx
      );
      return {
        changed: true,
        failures: [],
        finalWatermark: status.migration?.source_watermark
      };
    });
  }
  public async reverseReconcile(
    id: string,
    operator: MigrationOperator,
    limit = 100
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Batch limit must be 1..100');
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      if (status.migration?.state !== 'NATIVE' || !status.readiness)
        throw new Error('Native ownership required');
      assertMigrationRollbackSafe(status.readiness, status.completedEffects);
      if (status.migration.reverse_ready) return status;
      const limited = await this.rateLimit(repository, id, ctx);
      if (limited) return limited;
      const next = await reconcileLegacyBatch(
        this.supplier(),
        id,
        status.waveId,
        status.migration.reverse_checkpoint ?? {
          index: 0,
          phase: 'PRUNE',
          cursor: null
        },
        limit,
        ctx
      );
      await repository.update(
        id,
        {
          reverse_checkpoint: next,
          reverse_ready: next.index === LEGACY_GET_SOURCE_TABLES.length
        },
        ctx
      );
      await repository.audit(
        id,
        operator.actor,
        'REVERSE_RECONCILE_BATCH',
        operator.reason,
        { checkpoint: next, limit },
        ctx
      );
      return repository.status(id, ctx);
    });
  }
  private async reverseMismatches(
    id: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const db = this.supplier(),
      record = await new CompetitionMigrationRepository(() => db).lock(id, ctx),
      now = this.now();
    const baseline = await new LegacyCompetitionBaselineRepository(
      () => db
    ).getSnapshot(record, now, ctx, Number.POSITIVE_INFINITY);
    const candidate = await loadLegacyParityCandidate(
      new NativeCompetitionReader(
        new CompetitionRepository(() => db),
        ctx,
        record.storage_mode === 'LEGACY_ADAPTER'
      ),
      record,
      now,
      ctx,
      Number.POSITIVE_INFINITY
    );
    const failures = PARITY_FIELDS.filter(
      (field) =>
        competitionPayloadHash(baseline[field] ?? null) !==
        competitionPayloadHash(candidate[field] ?? null)
    );
    const relations = [
      ...(await compareLegacyFacade(db, id, record.wave_id, ctx)),
      ...(await compareMigrationContent(db, id, record.wave_id, ctx))
    ];
    return [
      ...failures,
      ...(sourceCreditOverspent(baseline) ? ['SOURCE_CREDIT_OVERSPENT'] : []),
      ...relations
        .filter((item) => item.baselineHash !== item.candidateHash)
        .map((item) => item.category)
    ];
  }
  public async rollback(
    id: string,
    operator: MigrationOperator,
    dryRun: boolean
  ) {
    return this.transaction(id, async (repository, ctx) => {
      const status = await repository.status(id, ctx);
      if (status.migration?.state !== 'NATIVE' || !status.readiness)
        throw new Error('Competition is not NATIVE');
      try {
        assertMigrationRollbackSafe(status.readiness, status.completedEffects);
      } catch {
        if (!dryRun) {
          await repository.update(id, { state: 'ROLLBACK_REQUIRED' }, ctx);
          await repository.audit(
            id,
            operator.actor,
            'ROLLBACK_REFUSED',
            operator.reason,
            { reason: 'NATIVE_DECISIONS_OR_EFFECTS' },
            ctx
          );
        }
        return { changed: false, repairRequired: true };
      }
      if (!status.migration.reverse_ready)
        return {
          changed: false,
          repairRequired: false,
          failures: ['REVERSE_RECONCILIATION_INCOMPLETE']
        };
      const failures = await this.reverseMismatches(id, ctx);
      if (failures.length) {
        if (!dryRun) {
          await repository.update(
            id,
            { reverse_checkpoint: null, reverse_ready: false },
            ctx
          );
          await repository.audit(
            id,
            operator.actor,
            'REVERSE_RECONCILIATION_MISMATCH',
            operator.reason,
            { failures },
            ctx
          );
        }
        return { changed: false, repairRequired: false, failures };
      }
      if (dryRun)
        return { changed: false, repairRequired: false, failures: [] };
      const transferred = await this.supplier().execute(
        `update ${COMPETITIONS_TABLE} set storage_mode='LEGACY_ADAPTER',execution_mode='ACTIVE' where id=:id and storage_mode='NATIVE'`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      if (this.supplier().getAffectedRows(transferred) !== 1)
        throw new Error('Ownership changed; rollback transaction aborted');
      await repository.update(id, { state: 'LEGACY' }, ctx);
      await repository.audit(
        id,
        operator.actor,
        'ROLLBACK',
        operator.reason,
        {
          reverseReconciliation:
            'bounded-native-materialization-and-independent-full-comparison',
          mismatches: 0
        },
        ctx
      );
      return { changed: true, repairRequired: false };
    });
  }
}
