import { appFeatures } from '@/app-features';
import { randomUUID } from 'node:crypto';
import {
  COMPETITIONS_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITION_MIGRATION_AUDIT_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_EVENT_EFFECTS_TABLE,
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { CompetitionMigrationEntity } from '@/entities/ICompetitionMigration';
import {
  CompetitionRecord,
  CompetitionRepository
} from '@/competitions/competition.repository';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { legacyCompetitionId } from '@/competitions/competition-id';
import {
  MigrationAcceptance,
  MigrationCohort,
  MigrationEnvironment,
  MigrationReadiness
} from '@/competitions/competition-migration-policy';
import { migrationCaptureHealthy } from '@/competitions/competition-migration-capture';
import { CompetitionMigrationEnvironmentRepository } from './competition-migration-environment.repository';
import { competitionPayloadHash } from './competition-command-identity';

function safeCounter(value: number | string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(
      'OWNED_EXCEPTION: migration counter exceeds supported integer range'
    );
  return number;
}

function json<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}
export type MigrationStatus = {
  readonly competitionId: string;
  readonly waveId: string;
  readonly storageMode: string;
  readonly executionMode: string;
  readonly migration: CompetitionMigrationEntity | null;
  readonly readiness: MigrationReadiness | null;
  readonly completedEffects: number;
  readonly operations?: {
    readonly journalLag: number;
    readonly publicationRetries: number;
    readonly oldestPendingPublicationAt: number | null;
    readonly recentActions: readonly {
      readonly action: string;
      readonly createdAt: number;
      readonly report: Record<string, unknown>;
    }[];
  };
};

export class CompetitionMigrationRepository extends LazyDbAccessCompatibleService {
  constructor(
    db: () => SqlExecutor = dbSupplier,
    private readonly environment: MigrationEnvironment = 'production'
  ) {
    super(db);
  }
  public async sourceEntryCount(
    waveId: string,
    ctx: RequestContext
  ): Promise<number> {
    const timer = `${this.constructor.name}->sourceEntryCount`;
    ctx.timer?.start(timer);
    try {
      const row = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${DROPS_TABLE} where wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER')`,
        { waveId },
        { wrappedConnection: ctx.connection }
      );
      return Number(row?.count ?? 0);
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  public async hasCompletedPilot(ctx: RequestContext): Promise<boolean> {
    const timer = `${this.constructor.name}->hasCompletedPilot`;
    ctx.timer?.start(timer);
    try {
      const row = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${COMPETITION_MIGRATIONS_TABLE} where cohort in ('COMPLETED_INTERNAL','COMPLETED_ORDINARY') and state='NATIVE'`,
        {},
        { wrappedConnection: ctx.connection }
      );
      return Number(row?.count ?? 0) > 0;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  public async lock(
    id: string,
    ctx: RequestContext
  ): Promise<CompetitionRecord> {
    const timerName = `${this.constructor.name}->lock`;
    ctx.timer?.start(timerName);
    try {
      if (!ctx.connection)
        throw new Error('Migration ownership operation requires a transaction');
      const record = await this.db.oneOrNull<CompetitionRecord>(
        `select * from ${COMPETITIONS_TABLE} where id=:id for update`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      if (
        !record?.legacy_wave_id ||
        record.id !== legacyCompetitionId(record.legacy_wave_id) ||
        record.wave_id !== record.legacy_wave_id
      )
        throw new Error('Explicit immutable legacy competition ID required');
      return record;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async status(
    id: string,
    ctx: RequestContext
  ): Promise<MigrationStatus> {
    const timerName = `${this.constructor.name}->status`;
    ctx.timer?.start(timerName);
    try {
      const record = await new CompetitionRepository(
        () => this.db
      ).findCompetitionRecordById(id, ctx);
      if (
        !record?.legacy_wave_id ||
        id !== legacyCompetitionId(record.legacy_wave_id)
      )
        throw new Error('Not a stable legacy competition ID');
      const raw = await this.db.oneOrNull<CompetitionMigrationEntity>(
        `select * from ${COMPETITION_MIGRATIONS_TABLE} where competition_id=:id`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      const effects = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${COMPETITION_EVENT_EFFECTS_TABLE} effect join ${COMPETITION_OUTBOX_TABLE} event on event.id=effect.event_id where event.competition_id=:id and effect.completed_at is not null`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      if (!raw)
        return {
          competitionId: id,
          waveId: record.wave_id,
          storageMode: record.storage_mode,
          executionMode: record.execution_mode,
          migration: null,
          readiness: null,
          completedEffects: Number(effects?.count ?? 0)
        };
      const migration = {
        ...raw,
        source_watermark: safeCounter(raw.source_watermark),
        applied_watermark: safeCounter(raw.applied_watermark),
        target_watermark: safeCounter(raw.target_watermark),
        reset_table_index:
          raw.reset_table_index === null ? null : Number(raw.reset_table_index),
        stage_offset: safeCounter(raw.stage_offset),
        next_batch_at:
          raw.next_batch_at === null ? null : Number(raw.next_batch_at),
        completed_stages: json(raw.completed_stages),
        reverse_checkpoint:
          raw.reverse_checkpoint === null ? null : json(raw.reverse_checkpoint),
        exceptions: json(raw.exceptions),
        acceptance: raw.acceptance === null ? null : json(raw.acceptance),
        last_window_end:
          raw.last_window_end === null ? null : Number(raw.last_window_end),
        last_comparison_at:
          raw.last_comparison_at === null
            ? null
            : Number(raw.last_comparison_at),
        last_comparison_watermark:
          raw.last_comparison_watermark === null
            ? null
            : safeCounter(raw.last_comparison_watermark),
        cutover_at: raw.cutover_at === null ? null : Number(raw.cutover_at),
        window_started_at:
          raw.window_started_at === null ? null : Number(raw.window_started_at),
        window_duration_ms:
          raw.window_duration_ms === null
            ? null
            : Number(raw.window_duration_ms),
        window_samples: safeCounter(raw.window_samples),
        cutover_decision_count:
          raw.cutover_decision_count === null
            ? null
            : safeCounter(raw.cutover_decision_count)
      };
      const pending = await this.db.oneOrNull<{ count: number }>(
        `select (select count(*) from ${COMPETITION_OUTBOX_TABLE} where competition_id=:id and delivered_at is null)+(select count(*) from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where competition_id=:id and completed_at is null) as count`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      const decisions =
        migration.cutover_at === null
          ? 0
          : Number(
              (
                await this.db.oneOrNull<{ count: number }>(
                  `select greatest(count(*)-:beforeCount,0) as count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
                  { id, beforeCount: migration.cutover_decision_count ?? 0 },
                  { wrappedConnection: ctx.connection }
                )
              )?.count ?? 0
            );
      const acceptance: MigrationAcceptance =
        (await new CompetitionMigrationEnvironmentRepository(
          () => this.db
        ).latest(this.environment, ctx)) ?? {
          productionEvidenceVerifiedBy: null,
          productionEvidenceVerifiedAt: null,
          comparisonWindowMs: null,
          nativeRankCompletion: null,
          nativeApproveCompletion: null,
          operationalAcceptance: null,
          compatibilityAcceptance: null,
          rollbackRehearsal: null,
          alertsVerified: null,
          serviceRevisions: {},
          apiBaselineP95: null,
          apiP95: null,
          apiBudgetP95: null,
          apiBaselineErrorRate: null,
          apiErrorRate: null,
          decisionBudgetP95: null,
          decisionBudgetP99: null,
          decisionP95: null,
          decisionP99: null,
          incidentWindowStartsAt: null,
          incidentWindowEndsAt: null
        };
      return {
        competitionId: id,
        waveId: record.wave_id,
        storageMode: record.storage_mode,
        executionMode: record.execution_mode,
        migration,
        operations: await this.operations(migration, ctx),
        completedEffects: Number(effects?.count ?? 0),
        readiness: {
          state: migration.state,
          owner: migration.owner,
          sourceWatermark: migration.source_watermark,
          appliedWatermark: migration.applied_watermark,
          completedStages: migration.completed_stages,
          consecutiveFullWindows: Number(migration.consecutive_full_windows),
          lastComparisonAt: migration.last_comparison_at,
          lastComparisonWatermark: migration.last_comparison_watermark,
          lastComparisonMatches: migration.window_samples > 0,
          currentAcceptanceMatches:
            competitionPayloadHash(migration.acceptance) ===
            competitionPayloadHash(acceptance),
          captureHealthy: await migrationCaptureHealthy(this.db, ctx),
          windowDurationMs: migration.window_duration_ms,
          compatibilityEnabled:
            appFeatures.isNativeCompetitionExecutionEnabled() &&
            appFeatures.isNativeCompetitionWritesEnabled(),
          pendingEffects: Number(pending?.count ?? 0),
          nativeDecisionsSinceCutover: decisions,
          unresolvedExceptions: migration.exceptions,
          acceptance
        }
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  private async operations(
    migration: CompetitionMigrationEntity,
    ctx: RequestContext
  ): Promise<NonNullable<MigrationStatus['operations']>> {
    const timerName = `${this.constructor.name}->operations`;
    ctx.timer?.start(timerName);
    try {
      const params = { id: migration.competition_id };
      const options = { wrappedConnection: ctx.connection };
      const actions = await this.db.execute<{
        action: string;
        created_at: number;
        report: Record<string, unknown> | string;
      }>(
        `select action,created_at,report from ${COMPETITION_MIGRATION_AUDIT_TABLE} where competition_id=:id order by created_at desc,id desc limit 10`,
        params,
        options
      );
      const effects = await this.db.oneOrNull<{
        retries: number;
        oldest: number | null;
      }>(
        `select coalesce(sum(greatest(attempts-1,0)),0) as retries,min(case when completed_at is null then created_at end) as oldest from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where competition_id=:id`,
        params,
        options
      );
      return {
        journalLag: migration.source_watermark - migration.applied_watermark,
        publicationRetries: Number(effects?.retries ?? 0),
        oldestPendingPublicationAt:
          effects?.oldest === null || effects?.oldest === undefined
            ? null
            : Number(effects.oldest),
        recentActions: actions.map((action) => ({
          action: action.action,
          createdAt: Number(action.created_at),
          report: json(action.report)
        }))
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async enroll(
    record: CompetitionRecord,
    owner: string,
    cohort: MigrationCohort,
    exceptions: readonly string[],
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->enroll`;
    ctx.timer?.start(timerName);
    try {
      if (record.storage_mode !== 'LEGACY_ADAPTER')
        throw new Error('Already native; enrollment cannot change ownership');
      await this.db.execute(
        `insert into ${COMPETITION_MIGRATIONS_TABLE} (competition_id,wave_id,state,cohort,owner,source_watermark,applied_watermark,stage,stage_offset,completed_stages,consecutive_full_windows,exceptions,updated_at) values (:id,:waveId,'BACKFILLING',:cohort,:owner,0,0,'CONFIGURATION',0,'[]',0,:exceptions,:now) on duplicate key update competition_id=competition_id`,
        {
          id: record.id,
          waveId: record.wave_id,
          owner,
          cohort,
          exceptions: JSON.stringify(exceptions),
          now: Date.now()
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async update(
    id: string,
    values: Partial<CompetitionMigrationEntity>,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->update`;
    ctx.timer?.start(timerName);
    try {
      const allowed = new Set([
        'owner',
        'cohort',
        'state',
        'stage',
        'stage_offset',
        'next_batch_at',
        'stage_cursor',
        'reverse_checkpoint',
        'reverse_ready',
        'completed_stages',
        'applied_watermark',
        'target_watermark',
        'reset_table_index',
        'consecutive_full_windows',
        'last_window_end',
        'last_comparison_at',
        'last_comparison_watermark',
        'acceptance',
        'exceptions',
        'cutover_at',
        'cutover_decision_count',
        'window_started_at',
        'window_duration_ms',
        'window_samples'
      ]);
      const entries = Object.entries(values);
      if (!entries.length || entries.some(([key]) => !allowed.has(key)))
        throw new Error('Unsupported migration update');
      const params = Object.fromEntries(
        entries.map(([key, value]) => [
          key,
          typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : value
        ])
      );
      await this.db.execute(
        `update ${COMPETITION_MIGRATIONS_TABLE} set ${entries.map(([key]) => `\`${key}\`=:${key}`).join(',')}, updated_at=:now where competition_id=:id`,
        { ...params, id, now: Date.now() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async audit(
    id: string,
    actor: string,
    action: string,
    reason: string,
    report: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->audit`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `insert into ${COMPETITION_MIGRATION_AUDIT_TABLE} (id,competition_id,actor,action,reason,report,created_at) values (:auditId,:id,:actor,:action,:reason,:report,:now)`,
        {
          auditId: randomUUID(),
          id,
          actor,
          action,
          reason,
          report: JSON.stringify(report),
          now: Date.now()
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async changesAfter(
    id: string,
    watermark: number,
    ctx: RequestContext
  ): Promise<number> {
    const timerName = `${this.constructor.name}->changesAfter`;
    ctx.timer?.start(timerName);
    try {
      const result = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${COMPETITION_MIGRATION_CHANGES_TABLE} where competition_id=:id and watermark>:watermark`,
        { id, watermark },
        { wrappedConnection: ctx.connection }
      );
      return Number(result?.count ?? 0);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}
