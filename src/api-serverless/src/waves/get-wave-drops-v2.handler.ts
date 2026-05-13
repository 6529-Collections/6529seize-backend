import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveDropsFeedV2 } from '@/api/generated/models/ApiWaveDropsFeedV2';
import { GetWaveDropsV2Request } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { apiWaveV2Service } from '@/api/waves/api-wave-v2.service';
import { enums } from '@/enums';
import { numbers } from '@/numbers';
import { Timer } from '@/time';
import * as Joi from 'joi';

type GetWaveDropsV2PathParams = {
  id: string;
};

const GetWaveDropsV2PathParamsSchema: Joi.ObjectSchema<GetWaveDropsV2PathParams> =
  Joi.object({
    id: Joi.string().required()
  });

export async function handleGetWaveDropsV2(
  req: GetWaveDropsV2Request
): Promise<ApiWaveDropsFeedV2> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    GetWaveDropsV2PathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const amount = numbers.parseIntOrNull(String(req.query.limit)) ?? 200;
  const serialNoLimit = req.query.serial_no_limit
    ? numbers.parseIntOrNull(String(req.query.serial_no_limit))
    : null;
  const searchStrategy =
    enums.resolve(ApiDropSearchStrategy, req.query.search_strategy) ??
    ApiDropSearchStrategy.Older;
  const dropType = req.query.drop_type
    ? (enums.resolve(ApiDropType, req.query.drop_type) ?? null)
    : null;

  return apiWaveV2Service.findDropsFeed(
    {
      wave_id: id,
      drop_id: null,
      amount: amount >= 200 || amount < 1 ? 50 : amount,
      serial_no_limit: serialNoLimit,
      search_strategy: searchStrategy,
      drop_type: dropType,
      curation_id: null
    },
    { authenticationContext, timer }
  );
}
