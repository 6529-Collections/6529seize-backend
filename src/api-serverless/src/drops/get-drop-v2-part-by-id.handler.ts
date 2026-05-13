import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { ApiDropPartV2 } from '@/api/generated/models/ApiDropPartV2';
import { GetDropV2PartByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2PartByIdPathParams = {
  id: string;
  part_no: number;
};

const GetDropV2PartByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2PartByIdPathParams> =
  Joi.object({
    id: Joi.string().required(),
    part_no: Joi.number().integer().min(1).required()
  });

export async function handleGetDropV2PartById(
  req: GetDropV2PartByIdRequest
): Promise<ApiDropPartV2> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id, part_no } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2PartByIdPathParamsSchema
  );
  return apiDropV2Service.findPartByDropIdOrThrow(id, part_no, {
    timer,
    authenticationContext
  });
}
