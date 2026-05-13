import { getAuthenticationContext } from '@/api/auth/auth';
import {
  apiDropV2Service,
  DropVotersSearchParams
} from '@/api/drops/api-drop-v2.service';
import { ApiDropVotersPage } from '@/api/generated/models/ApiDropVotersPage';
import { GetDropV2VotersByIdRequest } from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2VotersByIdPathParams = {
  id: string;
};

const GetDropV2VotersByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2VotersByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetDropV2VotersByIdQuerySchema: Joi.ObjectSchema<DropVotersSearchParams> =
  Joi.object({
    page_size: Joi.number().integer().min(1).max(100).default(20),
    page: Joi.number().integer().min(1).default(1),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.DESC)
  });

export async function handleGetDropV2VotersById(
  req: GetDropV2VotersByIdRequest
): Promise<ApiDropVotersPage> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2VotersByIdPathParamsSchema
  );
  const query = getValidatedByJoiOrThrow(
    req.query,
    GetDropV2VotersByIdQuerySchema
  );
  return apiDropV2Service.findVotersByDropIdOrThrow(id, query, {
    timer,
    authenticationContext
  });
}
