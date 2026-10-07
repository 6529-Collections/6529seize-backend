import { ApiCompetitionRulesInputTypeEnum } from '@/api/generated/models/ApiCompetitionRulesInput';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { ForbiddenException } from '@/exceptions';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { ApiCompetitionActionRequest } from '@/api/generated/models/ApiCompetitionActionRequest';
import { ApiUpdateCompetitionRequest } from '@/api/generated/models/ApiUpdateCompetitionRequest';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { ApiWave } from '@/api/generated/models/ApiWave';
import { waveApiService } from '@/api/waves/wave.api.service';
import { waveMetadataDb } from '@/api/waves/wave-metadata.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { competitionService } from '@/competitions/competition.service';
import {
  competitionCommandRepository,
  competitionConflict
} from '@/competitions/competition-command.repository';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';
import {
  LEGACY_INDEFINITE_PAUSE_END,
  legacyCompetitionSettingsRepository
} from '@/competitions/legacy-competition-settings.repository';
import { CompetitionStorageMode } from '@/entities/ICompetition';
import { BadRequestException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  administerCompetitionWave,
  competitionActor
} from './competition-command-access';
import { competitionPresentationKeys } from './competition-configuration';

export function legacyWaveUpdate(wave: ApiWave): ApiUpdateWaveRequest {
  return {
    name: wave.name,
    picture: wave.picture,
    visibility: {
      scope: { group_id: wave.visibility.scope.group?.id ?? null }
    },
    chat: {
      enabled: wave.chat.enabled,
      scope: { group_id: wave.chat.scope.group?.id ?? null },
      links_disabled: wave.chat.links_disabled,
      slow_mode_cooldown_ms: wave.chat.slow_mode_cooldown_ms
    },
    participation: {
      scope: { group_id: wave.participation.scope.group?.id ?? null },
      no_of_applications_allowed_per_participant:
        wave.participation.no_of_applications_allowed_per_participant,
      required_media: wave.participation.required_media,
      required_metadata: wave.participation.required_metadata,
      signature_required: wave.participation.signature_required,
      period: wave.participation.period ?? { min: null, max: null },
      terms: wave.participation.terms,
      submission_strategy: wave.participation.submission_strategy
    },
    voting: {
      scope: { group_id: wave.voting.scope.group?.id ?? null },
      credit_type: wave.voting.credit_type,
      credit_scope: wave.voting.credit_scope,
      credit_category: wave.voting.credit_category,
      creditor_id: wave.voting.creditor?.id ?? null,
      credit_nfts: wave.voting.credit_nfts,
      signature_required: wave.voting.signature_required,
      period: wave.voting.period ?? { min: null, max: null },
      forbid_negative_votes: wave.voting.forbid_negative_votes
    },
    wave: {
      type: wave.wave.type,
      admin_group: { group_id: wave.wave.admin_group.group?.id ?? null },
      admin_drop_deletion_enabled: wave.wave.admin_drop_deletion_enabled,
      winning_threshold: wave.wave.winning_threshold,
      winning_threshold_min_duration_ms:
        wave.wave.winning_threshold_min_duration_ms,
      max_winners: wave.wave.max_winners,
      max_votes_per_identity_to_drop: wave.wave.max_votes_per_identity_to_drop,
      time_lock_ms: wave.wave.time_lock_ms,
      decisions_strategy: wave.wave.decisions_strategy
    }
  };
}

export class LegacyCompetitionSettingsService {
  public async configuration(
    waveId: string,
    ctx: RequestContext
  ): Promise<ApiCompetitionDraftInput> {
    const { groups } = await administerCompetitionWave(waveId, ctx);
    const wave = await waveApiService.findWaveByIdOrThrow(waveId, groups, ctx);
    const update = legacyWaveUpdate(wave);
    const {
      admin_group: _admin,
      admin_drop_deletion_enabled: _delete,
      ...rules
    } = update.wave;
    const metadata = await waveMetadataDb.listByWaveId(waveId, ctx);
    return {
      title: update.name,
      description: null,
      participation: {
        ...update.participation,
        submission_strategy: update.participation.submission_strategy ?? null
      },
      voting: update.voting,
      rules: {
        ...rules,
        type:
          rules.type === ApiWaveType.Rank
            ? ApiCompetitionRulesInputTypeEnum.Rank
            : ApiCompetitionRulesInputTypeEnum.Approve,
        winning_threshold_min_duration_ms:
          rules.winning_threshold_min_duration_ms ?? null,
        max_votes_per_identity_to_drop:
          rules.max_votes_per_identity_to_drop ?? null
      },
      // Legacy outcomes retain their existing immutable wave definitions.
      outcomes: [],
      presentation: metadata
        .filter((item) => competitionPresentationKeys.includes(item.data_key))
        .map(({ data_key, data_value }) => ({ data_key, data_value }))
    };
  }

  private async lock(
    waveId: string,
    competitionId: string,
    version: number,
    ctx: RequestContext
  ) {
    const record = await competitionCommandRepository.lockCompetition(
      waveId,
      competitionId,
      ctx
    );
    if (record.storage_mode !== CompetitionStorageMode.LEGACY_ADAPTER)
      competitionConflict('Legacy competition required');
    await competitionCommandRepository.lockWave(waveId, ctx);
    const competition = await competitionService.getCompetition(
      waveId,
      competitionId,
      ctx
    );
    if (competition.config_version !== version)
      competitionConflict('Competition rules changed. Reload before retrying');
    await administerCompetitionWave(waveId, ctx);
    if (ctx.authenticationContext?.isAuthenticatedAsProxy())
      throw new ForbiddenException(
        'Legacy competition settings cannot be changed by proxies'
      );
    return competition;
  }

  public async update(
    waveId: string,
    competitionId: string,
    request: ApiUpdateCompetitionRequest,
    ctx: RequestContext
  ) {
    return competitionCommandRepository.command(
      competitionActor(ctx),
      request.idempotency_key,
      { waveId, competitionId, action: 'legacy-update', request },
      async (tx) => {
        await this.lock(waveId, competitionId, request.config_version, tx);
        const previous = await this.configuration(waveId, tx);
        if (request.config.rules.type !== previous.rules.type)
          throw new BadRequestException(
            'Legacy competition type cannot change'
          );
        if (
          request.config.description !== null ||
          competitionPayloadHash(request.config.outcomes) !==
            competitionPayloadHash(previous.outcomes)
        ) {
          throw new BadRequestException(
            'Legacy descriptions and outcome definitions are managed by the wave'
          );
        }
        const { groups } = await administerCompetitionWave(waveId, tx);
        const wave = await waveApiService.findWaveByIdOrThrow(
          waveId,
          groups,
          tx
        );
        const preserved = legacyWaveUpdate(wave);
        await waveApiService.updateWave(
          waveId,
          {
            ...preserved,
            name: request.config.title,
            participation: request.config.participation,
            voting: request.config.voting,
            wave: {
              ...preserved.wave,
              ...request.config.rules,
              type: preserved.wave.type
            }
          },
          tx
        );
        const metadata = await waveMetadataDb.listByWaveId(waveId, tx);
        for (const item of metadata.filter((item) =>
          competitionPresentationKeys.includes(item.data_key)
        )) {
          await waveMetadataDb.deleteByIdAndWaveId(item.id, waveId, tx);
        }
        for (const item of request.config.presentation) {
          await waveMetadataDb.create(
            { waveId, dataKey: item.data_key, dataValue: item.data_value },
            tx
          );
        }
        const version = Math.max(Date.now(), request.config_version + 1);
        await legacyCompetitionSettingsRepository.advanceVersion(
          competitionId,
          version,
          tx
        );
        await legacyCompetitionSettingsRepository.advanceWaveVersion(
          waveId,
          version,
          tx
        );
        return competitionService.getCompetition(waveId, competitionId, tx);
      },
      ctx
    );
  }

  public async action(
    waveId: string,
    competitionId: string,
    action: 'pause' | 'resume',
    request: ApiCompetitionActionRequest,
    ctx: RequestContext
  ) {
    return competitionCommandRepository.command(
      competitionActor(ctx),
      request.idempotency_key,
      { waveId, competitionId, action: `legacy-${action}`, request },
      async (tx) => {
        await this.lock(waveId, competitionId, request.config_version, tx);
        const now = Date.now();
        if (action === 'pause') {
          const start = request.starts_at ?? now;
          const end = request.ends_at ?? LEGACY_INDEFINITE_PAUSE_END;
          const reason = request.reason?.trim();
          if (!reason || start < now || end <= start)
            throw new BadRequestException(
              'A pause requires a reason and a valid future interval'
            );
          const pauses = await wavesApiDb.getWavePauses(waveId, tx);
          if (
            pauses.some(
              (pause) =>
                start < Number(pause.end_time) && end > Number(pause.start_time)
            )
          )
            throw new BadRequestException('Pause intervals cannot overlap');
          await waveApiService.createOrUpdateWavePause(
            waveId,
            { id: null, start_time: start, end_time: end },
            tx
          );
          await legacyCompetitionSettingsRepository.pause(
            waveId,
            start,
            end,
            reason,
            tx
          );
        } else {
          // Apply the same unresolved-decision guard used by the wave pause API.
          const wave = await wavesApiDb.findWaveById(waveId, tx.connection);
          if (wave?.next_decision_time && Number(wave.next_decision_time) < now)
            competitionConflict(
              'A competition decision is being finalized. Retry shortly'
            );
          await legacyCompetitionSettingsRepository.resume(waveId, now, tx);
        }
        const version = Math.max(now, request.config_version + 1);
        await legacyCompetitionSettingsRepository.advanceVersion(
          competitionId,
          version,
          tx
        );
        await legacyCompetitionSettingsRepository.advanceWaveVersion(
          waveId,
          version,
          tx
        );
        return competitionService.getCompetition(waveId, competitionId, tx);
      },
      ctx
    );
  }
}

export const legacyCompetitionSettingsService =
  new LegacyCompetitionSettingsService();
