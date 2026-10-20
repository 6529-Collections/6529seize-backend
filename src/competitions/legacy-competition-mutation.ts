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

/** Old commands retain the immutable primary identity and use native state. */
export async function withLegacyPrimaryMutation<T>(
  waveId: string,
  ctx: RequestContext,
  action: (native: CompetitionRecord | null) => Promise<T>
): Promise<T> {
  const record = await competitionRepository.lockOriginalPrimary(waveId, ctx);
  if (record && record.storage_mode !== 'NATIVE')
    throw new Error('Retired competition storage cannot accept commands');
  return withLegacyCompetitionGetFacade(() => action(record));
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
    await competitionCommandRepository.clearApprovalThresholds(record.id, ctx);
}
