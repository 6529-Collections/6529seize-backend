import { getAuthenticationContext } from '@/api/auth/auth';
import { dropsService } from '@/api/drops/drops.api.service';
import { ApiDropsLeaderboardPageV2 } from '@/api/generated/models/ApiDropsLeaderboardPageV2';
import { GetWaveLeaderboardV2Request } from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { LeaderboardParams, LeaderboardSort } from '@/drops/drops.db';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetWaveLeaderboardV2PathParams = {
  id: string;
};

const GetWaveLeaderboardV2PathParamsSchema: Joi.ObjectSchema<GetWaveLeaderboardV2PathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetWaveLeaderboardV2QuerySchema: Joi.ObjectSchema<
  Omit<LeaderboardParams, 'wave_id'>
> = Joi.object<Omit<LeaderboardParams, 'wave_id'>>({
  page_size: Joi.number().integer().min(1).max(100).default(50),
  page: Joi.number().integer().min(1).default(1),
  curation_id: Joi.string().optional().default(null),
  unvoted_by_me: Joi.boolean().optional().default(false),
  price_currency: Joi.string().trim().empty('').optional().default(null),
  min_price: Joi.number().min(0).optional().default(null),
  max_price: Joi.number().min(0).optional().default(null),
  sort_direction: Joi.string()
    .valid(...Object.values(PageSortDirection))
    .default(PageSortDirection.ASC),
  sort: Joi.string()
    .valid(...Object.values(LeaderboardSort))
    .default(LeaderboardSort.RANK)
});

export async function handleGetWaveLeaderboardV2(
  req: GetWaveLeaderboardV2Request
): Promise<ApiDropsLeaderboardPageV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetWaveLeaderboardV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const params: LeaderboardParams = {
    wave_id: id,
    ...getValidatedByJoiOrThrow(req.query, GetWaveLeaderboardV2QuerySchema)
  };
  return dropsService.findLeaderboardV2(params, {
    authenticationContext,
    timer
  });
}
