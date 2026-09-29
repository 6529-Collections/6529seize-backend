import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { ApiActiveWaveVotesPage } from '@/api/generated/models/ApiActiveWaveVotesPage';
import { GetActiveWaveVotesRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { apiWaveOverviewMapper } from '@/api/waves/api-wave-overview.mapper';
import { getGroupsUserIsEligibleForReadContext } from '@/api/waves/wave-access.helpers';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { Timer, Time } from '@/time';

export async function handleGetActiveWaveVotes(
  req: GetActiveWaveVotesRequest
): Promise<ApiActiveWaveVotesPage> {
  const { page, page_size } = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ page: number; page_size: number }>({
      page: Joi.number().integer().min(1).max(1000000).default(1),
      page_size: Joi.number().integer().min(1).max(50).default(20)
    }).unknown(false)
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const ctx = { timer, authenticationContext };
  const eligibleGroups = await getGroupsUserIsEligibleForReadContext(
    userGroupsService,
    ctx
  );
  const { waves, count } = await wavesApiDb.findActiveTdhVotingWaves(
    {
      eligibleGroups,
      now: Time.currentMillis(),
      limit: page_size,
      offset: (page - 1) * page_size
    },
    ctx
  );
  const mapped = await apiWaveOverviewMapper.mapWaves(waves, ctx, {
    groupIdsUserIsEligibleFor: eligibleGroups
  });
  return {
    data: waves.map((wave) => ({
      wave: mapped[wave.id],
      voting_ends_at:
        wave.voting_period_end === null ? null : Number(wave.voting_period_end),
      next_decision_at:
        wave.next_decision_time === null
          ? null
          : Number(wave.next_decision_time)
    })),
    page,
    next: page * page_size < count,
    count
  };
}
