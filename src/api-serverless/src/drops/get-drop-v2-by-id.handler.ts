import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { ApiDropAndWave } from '@/api/generated/models/ApiDropAndWave';
import { GetDropV2ByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2ByIdPathParams = {
  id: string;
};

const GetDropV2ByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2ByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

export async function handleGetDropV2ById(
  req: GetDropV2ByIdRequest
): Promise<ApiDropAndWave> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2ByIdPathParamsSchema
  );
  return apiDropV2Service.findWithWaveByIdOrThrow(id, {
    timer,
    authenticationContext
  });
}
