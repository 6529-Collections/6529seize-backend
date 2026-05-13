import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { ApiDropReactionV2 } from '@/api/generated/models/ApiDropReactionV2';
import { GetDropV2ReactionsByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2ReactionsByIdPathParams = {
  id: string;
};

const GetDropV2ReactionsByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2ReactionsByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

export async function handleGetDropV2ReactionsById(
  req: GetDropV2ReactionsByIdRequest
): Promise<ApiDropReactionV2[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2ReactionsByIdPathParamsSchema
  );
  return apiDropV2Service.findReactionsByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
}
