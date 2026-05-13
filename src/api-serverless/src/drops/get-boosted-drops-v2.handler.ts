import { getAuthenticationContext } from '@/api/auth/auth';
import {
  apiDropV2Service,
  FindBoostedDropsV2Request
} from '@/api/drops/api-drop-v2.service';
import { ApiDropV2Page } from '@/api/generated/models/ApiDropV2Page';
import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import { GetBoostedDropsV2Request } from '@/api/generated/routes/operations';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

const FindBoostedDropsV2RequestSchema: Joi.ObjectSchema<FindBoostedDropsV2Request> =
  Joi.object<FindBoostedDropsV2Request>({
    author: Joi.string().default(null),
    booster: Joi.string().default(null),
    wave_id: Joi.string().default(null),
    min_boosts: Joi.number().integer().default(null),
    count_only_boosts_after: Joi.number().integer().positive().default(1),
    page_size: Joi.number()
      .integer()
      .default(DEFAULT_PAGE_SIZE)
      .max(DEFAULT_MAX_SIZE)
      .min(1),
    page: Joi.number().integer().default(1).min(1),
    sort_direction: Joi.string()
      .valid(...Object.values(ApiPageSortDirection))
      .default(ApiPageSortDirection.Desc),
    sort: Joi.string()
      .valid('last_boosted_at', 'first_boosted_at', 'drop_created_at', 'boosts')
      .default('last_boosted_at')
  });

export async function handleGetBoostedDropsV2(
  req: GetBoostedDropsV2Request
): Promise<ApiDropV2Page> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const searchRequest = getValidatedByJoiOrThrow(
    req.query,
    FindBoostedDropsV2RequestSchema
  );
  return apiDropV2Service.findBoostedDrops(searchRequest, {
    timer,
    authenticationContext
  });
}
