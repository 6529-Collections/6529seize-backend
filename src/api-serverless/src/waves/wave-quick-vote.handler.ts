import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiUndiscoveredDrops } from '@/api/generated/models/ApiUndiscoveredDrops';
import { GetWaveUndiscoveredDropsRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { getQuickVoteIdentity } from '@/api/waves/wave-quick-vote-auth';
import { waveQuickVoteApiService } from '@/api/waves/wave-quick-vote.api.service';
import { Timer } from '@/time';

export async function handleGetWaveUndiscoveredDrops(
  req: GetWaveUndiscoveredDropsRequest
): Promise<ApiUndiscoveredDrops> {
  const { limit } = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ limit: number }>({
      limit: Joi.number().integer().min(1).max(4).default(4)
    }).unknown(false)
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return await waveQuickVoteApiService.findUndiscoveredDrops(
    {
      waveId: req.params.id,
      identityId: getQuickVoteIdentity(authenticationContext),
      limit
    },
    { authenticationContext, timer }
  );
}
