import { dbSupplier } from '@/sql-executor';
import { appFeatures } from '@/app-features';
import { ForbiddenException } from '@/exceptions';
import { withNativeLegacyMirror } from './legacy-competition-mirror';
import {
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_PAUSES_TABLE,
  WAVES_DECISION_PAUSES_TABLE
} from '@/constants';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { configurationToRecord } from '@/api/competitions/competition-configuration';
import { CompetitionEntity } from '@/entities/ICompetition';
import { RequestContext } from '@/request.context';
import { competitionCommandRepository } from './competition-command.repository';
import {
  CompetitionRecord,
  competitionRepository
} from './competition.repository';
import {
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';

/** Every old primary command locks before touching its wave/drop/vote rows.
 * Validation reads the native projection after transfer. Mirrored writes and
 * forward reconciliation remain one transaction and cannot change ownership. */
export async function withLegacyPrimaryMutation<T>(
  waveId: string,
  ctx: RequestContext,
  action: (native: CompetitionRecord | null) => Promise<T>
): Promise<T> {
  const record = await competitionRepository.lockLegacyExecutionOwner(
    waveId,
    ctx
  );
  if (record?.storage_mode !== 'NATIVE') return action(null);
  return withNativeLegacyMirror(dbSupplier(), record.id, ctx, () =>
    withLegacyCompetitionGetFacade(() => action(record))
  );
}

export function readLegacyMutationSource<T>(action: () => T): T {
  return withoutLegacyCompetitionGetFacade(action);
}

/** Accepted old settings are translated into the native configuration version.
 * No wave-owned competition rows are written or re-read for reconciliation. */
export async function reconcileAcceptedLegacySettings(
  record: CompetitionRecord,
  actor: string,
  request: ApiUpdateWaveRequest,
  nextDecisionTime: number | null,
  ctx: RequestContext
): Promise<void> {
  if (!appFeatures.isNativeCompetitionWritesEnabled())
    throw new ForbiddenException(
      'Competition changes are temporarily unavailable'
    );
  const { loadNativeCommandConfiguration } =
    await import('@/api/competitions/competition-command-configuration');
  const previous = await loadNativeCommandConfiguration(record, ctx);
  const {
    admin_group: _admin,
    admin_drop_deletion_enabled: _delete,
    ...rules
  } = request.wave;
  const config: ApiCompetitionDraftInput = {
    ...previous,
    title: request.name,
    participation: {
      ...request.participation,
      submission_strategy: request.participation.submission_strategy ?? null
    },
    voting: request.voting,
    rules: { ...previous.rules, ...rules, type: previous.rules.type }
  };
  const approvalRulesChanged =
    config.rules.type === 'APPROVE' &&
    (config.rules.winning_threshold !== previous.rules.winning_threshold ||
      config.rules.winning_threshold_min_duration_ms !==
        previous.rules.winning_threshold_min_duration_ms);
  const oldEntity = competitionRepository.parseCompetitionRecord(
    record
  ) as unknown as CompetitionEntity;
  const updated = configurationToRecord(config, oldEntity);
  const { NativeCompetitionReader } =
    await import('./native-competition.reader');
  const { nativeCompetitionRuntimeService } =
    await import('./native-competition-runtime.service');
  const now = Date.now();
  const competition = await new NativeCompetitionReader(
    competitionRepository,
    ctx
  ).getCompetition(record, now);
  await nativeCompetitionRuntimeService.enqueueDueTransitions(
    competition,
    now,
    ctx
  );
  await competitionCommandRepository.saveCompetition(
    {
      ...updated,
      presentation_config: oldEntity.presentation_config,
      decision_config: {
        ...updated.decision_config,
        next_decision_time: nextDecisionTime
      },
      config_version: Number(record.config_version) + 1,
      updated_at: now
    },
    actor,
    config,
    ctx
  );
  if (approvalRulesChanged)
    await dbSupplier().execute(
      `update ${COMPETITION_ENTRY_RUNTIME_TABLE} set over_threshold_since = null where competition_id = :competitionId`,
      { competitionId: record.id },
      { wrappedConnection: ctx.connection }
    );
}

/** Apply only the accepted pause command. Native pauses added by the next
 * release must survive even when their physical compatibility row is stale. */
export async function applyAcceptedLegacyPause(
  record: CompetitionRecord,
  command: {
    id: number | null;
    startTime?: number;
    endTime?: number;
    reason?: string;
  },
  ctx: RequestContext
): Promise<void> {
  if (!appFeatures.isNativeCompetitionWritesEnabled())
    throw new ForbiddenException(
      'Competition changes are temporarily unavailable'
    );
  const db = dbSupplier(),
    options = { wrappedConnection: ctx.connection };
  if (command.id !== null) {
    await db.execute(
      `delete from ${COMPETITION_PAUSES_TABLE} where competition_id=:competitionId and legacy_source_id=:id`,
      { competitionId: record.id, id: command.id },
      options
    );
    await db.execute(
      `delete from ${WAVES_DECISION_PAUSES_TABLE} where wave_id=:waveId and id=:id`,
      { waveId: record.wave_id, id: command.id },
      options
    );
  }
  if (command.startTime !== undefined && command.endTime !== undefined)
    await competitionCommandRepository.pause(
      record.id,
      command.startTime,
      command.endTime,
      command.reason ?? null,
      ctx
    );
}
