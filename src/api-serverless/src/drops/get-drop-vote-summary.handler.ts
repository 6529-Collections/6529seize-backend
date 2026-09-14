import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { ApiDropVoteSummary } from '@/api/generated/models/ApiDropVoteSummary';
import { GetDropV2VoteSummaryByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

const VoteSummaryPathSchema = Joi.object<
  GetDropV2VoteSummaryByIdRequest['params']
>({
  id: Joi.string().trim().required()
});

export async function handleGetDropV2VoteSummaryById(
  req: GetDropV2VoteSummaryByIdRequest
): Promise<ApiDropVoteSummary> {
  const { id } = getValidatedByJoiOrThrow(req.params, VoteSummaryPathSchema);
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return apiDropV2Service.findVoteSummaryByDropIdOrThrow(id, {
    authenticationContext,
    timer
  });
}
