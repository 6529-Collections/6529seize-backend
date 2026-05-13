import { getAuthenticationContext } from '@/api/auth/auth';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';
import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';
import { GetDropV2MetadataByIdRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2MetadataByIdPathParams = {
  id: string;
};

const GetDropV2MetadataByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2MetadataByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

export async function handleGetDropV2MetadataById(
  req: GetDropV2MetadataByIdRequest
): Promise<ApiDropMetadataV2[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2MetadataByIdPathParamsSchema
  );
  return apiDropV2Service.findMetadataByDropIdOrThrow(id, {
    timer,
    authenticationContext
  });
}
