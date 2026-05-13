import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { ApiDropBoostV2 } from '@/api/generated/models/ApiDropBoostV2';
import { GetDropV2BoostsByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2BoostsByIdPathParams = {
  id: string;
};

const GetDropV2BoostsByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2BoostsByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

export async function handleGetDropV2BoostsById(
  req: GetDropV2BoostsByIdRequest
): Promise<ApiDropBoostV2[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2BoostsByIdPathParamsSchema
  );
  return apiDropV2Service.findBoostsByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
}
