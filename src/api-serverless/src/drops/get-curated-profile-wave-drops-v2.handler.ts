import { getAuthenticationContext } from '@/api/auth/auth';
import {
  apiDropV2Service,
  FindCuratedProfileWaveDropsV2Request
} from '@/api/drops/api-drop-v2.service';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { GetCuratedProfileWaveDropsV2Request } from '@/api/generated/routes/operations';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import * as Joi from 'joi';

const FindCuratedProfileWaveDropsV2RequestSchema: Joi.ObjectSchema<FindCuratedProfileWaveDropsV2Request> =
  Joi.object({
    page: Joi.number().integer().default(1).min(1),
    page_size: Joi.number()
      .integer()
      .default(DEFAULT_PAGE_SIZE)
      .max(DEFAULT_MAX_SIZE)
      .min(1)
  });

export async function handleGetCuratedProfileWaveDropsV2(
  req: GetCuratedProfileWaveDropsV2Request
): Promise<ApiDropV2PageWithoutCount> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const request =
    getValidatedByJoiOrThrow<FindCuratedProfileWaveDropsV2Request>(
      req.query,
      FindCuratedProfileWaveDropsV2RequestSchema
    );
  return apiDropV2Service.findCuratedProfileWaveDrops(request, {
    authenticationContext,
    timer
  });
}
