import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { ListWaveCurationDropsV2Request } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { apiWaveV2Service } from '@/api/waves/api-wave-v2.service';
import { Timer } from '@/time';
import * as Joi from 'joi';

type ListWaveCurationDropsV2PathParams = {
  id: string;
  curation_id: string;
};

type ListWaveCurationDropsV2Query = {
  page: number;
  page_size: number;
};

const ListWaveCurationDropsV2PathParamsSchema: Joi.ObjectSchema<ListWaveCurationDropsV2PathParams> =
  Joi.object({
    id: Joi.string().required(),
    curation_id: Joi.string().required()
  });

const ListWaveCurationDropsV2QuerySchema: Joi.ObjectSchema<ListWaveCurationDropsV2Query> =
  Joi.object<ListWaveCurationDropsV2Query>({
    page: Joi.number().integer().min(1).optional().default(1),
    page_size: Joi.number().integer().min(1).max(100).optional().default(50)
  });

export async function handleListWaveCurationDropsV2(
  req: ListWaveCurationDropsV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { id, curation_id } = getValidatedByJoiOrThrow(
    req.params,
    ListWaveCurationDropsV2PathParamsSchema
  );
  const { page, page_size } = getValidatedByJoiOrThrow(
    req.query,
    ListWaveCurationDropsV2QuerySchema
  );
  return apiWaveV2Service.findWaveCurationDrops(
    {
      wave_id: id,
      curation_id,
      page,
      page_size
    },
    { authenticationContext, timer }
  );
}
