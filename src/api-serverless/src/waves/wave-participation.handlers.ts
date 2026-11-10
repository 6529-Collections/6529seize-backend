import * as Joi from 'joi';
import { AuthenticationContext } from '@/auth-context';
import { WaveEntity } from '@/entities/IWave';
import { enums } from '@/enums';
import { isLegacyDmClosed } from '@/legacy-dm/legacy-dm-retention';
import { RequestContext } from '@/request.context';
import { Time, Timer } from '@/time';
import { isWaveChatSlowModeActive } from '@/waves/wave-chat-slow-mode.helpers';
import {
  evaluateWaveParticipationDecisions,
  WaveParticipationDecision,
  WaveParticipationIdentity,
  waveParticipationIdentityFromAuthContext
} from '@/waves/wave-participation-decision';
import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { ApiWaveParticipation } from '@/api/generated/models/ApiWaveParticipation';
import { ApiWaveParticipationAction } from '@/api/generated/models/ApiWaveParticipationAction';
import { ApiWaveParticipationDecision } from '@/api/generated/models/ApiWaveParticipationDecision';
import { ApiWaveParticipationEvaluation } from '@/api/generated/models/ApiWaveParticipationEvaluation';
import { ApiWaveParticipationReasonCode } from '@/api/generated/models/ApiWaveParticipationReasonCode';
import { GetWaveParticipationRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  assertWaveAndParentVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext,
  getWaveReadContextProfileId
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb } from '@/api/waves/waves.api.db';

const PathParamsSchema = Joi.object<{ id: string }>({
  id: Joi.string().min(1).max(100).required()
});

/**
 * The write path judges membership for the acting profile. Read context
 * already resolved it unless the caller is a proxy without READ_WAVE, in
 * which case it is fetched for the acting profile (a proxy without
 * CREATE_DROP_TO_WAVE is denied before membership matters).
 */
async function resolveDecisionGroups({
  identity,
  authenticationContext,
  readContextGroups,
  ctx
}: {
  identity: WaveParticipationIdentity;
  authenticationContext: AuthenticationContext;
  readContextGroups: string[];
  ctx: RequestContext;
}): Promise<string[]> {
  if (
    !identity.profileId ||
    !identity.hasCreateDropRights ||
    getWaveReadContextProfileId(authenticationContext) === identity.profileId
  ) {
    return readContextGroups;
  }
  return await userGroupsService.getGroupsUserIsEligibleFor(
    identity.profileId,
    ctx.timer
  );
}

async function resolveNextDropTimestamp(
  wave: WaveEntity,
  identity: WaveParticipationIdentity,
  ctx: RequestContext
): Promise<number | null> {
  if (!identity.profileId || !isWaveChatSlowModeActive(wave)) {
    return null;
  }
  const cooldowns = await wavesApiDb.findWaveChatDropCooldownsByWaveIds(
    { profileId: identity.profileId, waveIds: [wave.id] },
    ctx
  );
  return cooldowns[wave.id]?.next_drop_timestamp ?? null;
}

function toApiDecision(
  decision: WaveParticipationDecision
): ApiWaveParticipationDecision {
  const api: ApiWaveParticipationDecision = {
    action: enums.resolveOrThrow(ApiWaveParticipationAction, decision.action),
    allowed: decision.allowed,
    constraints: { ...decision.constraints },
    evaluation: enums.resolveOrThrow(
      ApiWaveParticipationEvaluation,
      decision.evaluation
    )
  };
  if (decision.reason_code !== undefined) {
    api.reason_code = enums.resolveOrThrow(
      ApiWaveParticipationReasonCode,
      decision.reason_code
    );
  }
  if (decision.retry_at !== undefined) {
    api.retry_at = decision.retry_at;
  }
  return api;
}

export async function handleGetWaveParticipation(
  req: GetWaveParticipationRequest
): Promise<ApiWaveParticipation> {
  const { id } = getValidatedByJoiOrThrow(req.params, PathParamsSchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const ctx: RequestContext = { timer, authenticationContext };
  // Membership unavailable (503) propagates from here, as it does on write.
  const readContextGroups = await getGroupsUserIsEligibleForReadContext(
    userGroupsService,
    ctx
  );
  // Visibility first: a hidden wave or parent is a 404, never a reason code.
  const wave = await assertWaveAndParentVisibleOrThrow({
    wave: await wavesApiDb.findWaveById(id),
    groupsUserIsEligibleFor: readContextGroups,
    message: `Wave ${id} not found`,
    wavesApiDb,
    ctx
  });
  const identity = waveParticipationIdentityFromAuthContext(
    authenticationContext
  );
  const groupIdsUserIsEligibleFor = await resolveDecisionGroups({
    identity,
    authenticationContext,
    readContextGroups,
    ctx
  });
  const nextDropTimestamp = await resolveNextDropTimestamp(wave, identity, ctx);
  const now = Time.currentMillis();
  const decisions = evaluateWaveParticipationDecisions({
    wave,
    identity,
    groupIdsUserIsEligibleFor,
    nextDropTimestamp,
    legacyDmClosed: wave.is_direct_message === true && isLegacyDmClosed(now),
    now
  });
  return {
    wave_id: wave.id,
    evaluated_at: now,
    decisions: decisions.map(toApiDecision)
  };
}
