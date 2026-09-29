import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { appFeatures } from '@/app-features';
import { ApiCreateWaveHubRequest } from '@/api/generated/models/ApiCreateWaveHubRequest';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { waveApiService } from '@/api/waves/wave.api.service';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { competitionService } from '@/competitions/competition.service';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { competitionActor } from './competition-command-access';

export class WaveHubCreationService {
  private readonly logger = Logger.get(this.constructor.name);

  public async create(request: ApiCreateWaveHubRequest, ctx: RequestContext) {
    if (!appFeatures.isNativeCompetitionHubCreationEnabled())
      throw new NotFoundException('Hub creation is not enabled');
    const actor = competitionActor(ctx);
    if (
      !ctx.authenticationContext?.hasRightsTo(
        ProfileProxyActionType.CREATE_WAVE
      )
    )
      throw new ForbiddenException('Wave creation is not permitted');
    const payload = { action: 'create_hub', request };
    const saved = await competitionCommandRepository.findSavedCommand<{
      id: string;
    }>(actor, request.idempotency_key, payload, ctx);
    if (saved) return competitionService.getHub(saved.id, ctx);
    const waveRequest: ApiCreateNewWave = {
      name: request.name,
      picture: request.picture,
      description_drop: request.description_drop,
      parent_wave_id: request.parent_wave_id,
      visibility: request.visibility,
      chat: request.chat,
      voting: {
        scope: { group_id: request.visibility.scope.group_id },
        credit_type: ApiWaveCreditType.Tdh,
        credit_scope: ApiWaveCreditScope.Wave,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        forbid_negative_votes: false,
        period: { min: null, max: null }
      },
      participation: {
        scope: { group_id: request.visibility.scope.group_id },
        required_media: [],
        required_metadata: [],
        no_of_applications_allowed_per_participant: null,
        signature_required: false,
        terms: null,
        period: { min: null, max: null }
      },
      wave: {
        type: ApiWaveType.Chat,
        admin_group: request.admin_group,
        winning_threshold: null,
        winning_threshold_min_duration_ms: null,
        max_winners: null,
        max_votes_per_identity_to_drop: null,
        time_lock_ms: null,
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      },
      outcomes: []
    };
    const prepared = await waveApiService.prepareWaveCreation(waveRequest, ctx);
    const effects: Array<() => Promise<void>> = [];
    const result = await competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      payload,
      async (tx) => {
        const wave = await waveApiService.createWave(
          waveRequest,
          false,
          tx,
          effects,
          prepared
        );
        // A newly referenced private group is absent from the all-wave
        // eligibility cache until the wave commits and its effects run.
        return { id: wave.id };
      },
      ctx
    );
    for (const effect of effects) {
      try {
        await effect();
      } catch {
        this.logger.warn('Native hub post-commit refresh failed', {
          wave_id: result.id
        });
      }
    }
    return competitionService.getHub(result.id, {
      ...ctx,
      connection: undefined
    });
  }
}

export const waveHubCreationService = new WaveHubCreationService();
