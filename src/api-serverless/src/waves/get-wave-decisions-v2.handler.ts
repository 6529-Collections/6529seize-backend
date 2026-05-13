import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiWaveDecisionsPageV2 } from '@/api/generated/models/ApiWaveDecisionsPageV2';
import { GetWaveDecisionsV2Request } from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  waveDecisionsApiService,
  WaveDecisionsQuery,
  WaveDecisionsQuerySort
} from '@/api/waves/wave-decisions-api.service';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetWaveDecisionsV2PathParams = {
  id: string;
};

const GetWaveDecisionsV2PathParamsSchema: Joi.ObjectSchema<GetWaveDecisionsV2PathParams> =
  Joi.object({
    id: Joi.string().required()
  });

const GetWaveDecisionsV2QuerySchema: Joi.ObjectSchema<
  Omit<WaveDecisionsQuery, 'wave_id'>
> = Joi.object<Omit<WaveDecisionsQuery, 'wave_id'>>({
  page_size: Joi.number().integer().min(1).max(2000).default(100),
  page: Joi.number().integer().min(1).default(1),
  sort_direction: Joi.string()
    .valid(...Object.values(PageSortDirection))
    .default(PageSortDirection.DESC),
  sort: Joi.string()
    .valid(...Object.values(WaveDecisionsQuerySort))
    .default(WaveDecisionsQuerySort.decision_time)
});

export async function handleGetWaveDecisionsV2(
  req: GetWaveDecisionsV2Request
): Promise<ApiWaveDecisionsPageV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetWaveDecisionsV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const params: WaveDecisionsQuery = {
    wave_id: id,
    ...getValidatedByJoiOrThrow(req.query, GetWaveDecisionsV2QuerySchema)
  };
  return waveDecisionsApiService.searchConcludedWaveDecisionsV2(params, {
    authenticationContext,
    timer
  });
}
