import { Request, Response } from 'express';
import * as Joi from 'joi';
import { Timer } from '@/time';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '@/api/auth/auth';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  apiDropV2Service,
  FindCuratedProfileWaveDropsV2Request
} from '@/api/drops/api-drop-v2.service';

const router = asyncRouter();

const FindCuratedProfileWaveDropsV2RequestSchema: Joi.ObjectSchema<FindCuratedProfileWaveDropsV2Request> =
  Joi.object({
    page: Joi.number().integer().default(1).min(1),
    page_size: Joi.number()
      .integer()
      .default(DEFAULT_PAGE_SIZE)
      .max(DEFAULT_MAX_SIZE)
      .min(1)
  });

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, Partial<FindCuratedProfileWaveDropsV2Request>>,
    res: Response<ApiResponse<ApiDropV2PageWithoutCount>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request =
      getValidatedByJoiOrThrow<FindCuratedProfileWaveDropsV2Request>(
        req.query as FindCuratedProfileWaveDropsV2Request,
        FindCuratedProfileWaveDropsV2RequestSchema
      );
    const result = await apiDropV2Service.findCuratedProfileWaveDrops(request, {
      authenticationContext,
      timer
    });
    res.send(result);
  }
);

export default router;
