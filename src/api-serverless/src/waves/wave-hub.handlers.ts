import * as Joi from 'joi';
import { ApiWaveV3 } from '@/api/generated/models/ApiWaveV3';
import { UpdateWaveHubV3Request } from '@/api/generated/routes/operations';
import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { competitionService } from '@/competitions/competition.service';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { getGroupsUserIsEligibleForReadContext } from './wave-access.helpers';
import { waveApiService } from './wave.api.service';
import { UpdateWaveHubSchema } from './wave-hub.schemas';

export async function readWaveHub(
  waveId: string,
  ctx: RequestContext
): Promise<ApiWaveV3> {
  const groups = await getGroupsUserIsEligibleForReadContext(
    userGroupsService,
    ctx
  );
  const configuration = await waveApiService.findWaveByIdOrThrow(
    waveId,
    groups,
    ctx,
    true
  );
  const hub = await competitionService.getHub(waveId, ctx);
  return {
    ...hub,
    name: configuration.name,
    picture: configuration.picture,
    capabilities: { ...hub.capabilities, chat: configuration.chat.enabled },
    permissions: {
      ...hub.permissions,
      chat:
        configuration.chat.enabled &&
        configuration.chat.authenticated_user_eligible,
      administer: configuration.wave.authenticated_user_eligible_for_admin,
      create_competition:
        configuration.wave.authenticated_user_eligible_for_admin
    },
    configuration
  };
}

export async function handleUpdateWaveHubV3(
  req: UpdateWaveHubV3Request
): Promise<ApiWaveV3> {
  getValidatedByJoiOrThrow(req.query, Joi.object({}));
  const { wave_id } = getValidatedByJoiOrThrow(
    req.params,
    Joi.object({ wave_id: Joi.string().min(1).max(100).required() })
  );
  const patch = getValidatedByJoiOrThrow(
    req.body,
    UpdateWaveHubSchema.required()
  );
  const timer = Timer.getFromRequest(req);
  const ctx = {
    timer,
    authenticationContext: await getAuthenticationContext(req, timer)
  };
  const hub = await competitionService.getHub(wave_id, ctx);
  const configuration = await waveApiService.updateWaveHub(wave_id, patch, ctx);
  return {
    ...hub,
    name: configuration.name,
    picture: configuration.picture,
    capabilities: { ...hub.capabilities, chat: configuration.chat.enabled },
    permissions: {
      ...hub.permissions,
      chat:
        configuration.chat.enabled &&
        configuration.chat.authenticated_user_eligible,
      administer: configuration.wave.authenticated_user_eligible_for_admin,
      create_competition:
        configuration.wave.authenticated_user_eligible_for_admin
    },
    configuration
  };
}
