import { getAuthenticationContext } from '@/api/auth/auth';
import {
  apiDropV2Service,
  DropVoteEditLogsSearchParams
} from '@/api/drops/api-drop-v2.service';
import { ApiDropVoteEditLog } from '@/api/generated/models/ApiDropVoteEditLog';
import { GetDropV2VoteEditLogsByIdRequest } from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetDropV2VoteEditLogsByIdPathParams = {
  id: string;
};

const GetDropV2VoteEditLogsByIdPathParamsSchema: Joi.ObjectSchema<GetDropV2VoteEditLogsByIdPathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetDropV2VoteEditLogsByIdQuerySchema: Joi.ObjectSchema<DropVoteEditLogsSearchParams> =
  Joi.object({
    offset: Joi.number().integer().min(0).default(0),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.DESC)
  });

export async function handleGetDropV2VoteEditLogsById(
  req: GetDropV2VoteEditLogsByIdRequest
): Promise<ApiDropVoteEditLog[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetDropV2VoteEditLogsByIdPathParamsSchema
  );
  const query = getValidatedByJoiOrThrow(
    req.query,
    GetDropV2VoteEditLogsByIdQuerySchema
  );
  return apiDropV2Service.findVoteEditLogsByDropIdOrThrow(id, query, {
    timer,
    authenticationContext
  });
}
