import { Request, Response } from 'express';
import * as Joi from 'joi';
import { Timer } from '@/time';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '@/api/auth/auth';
import { ApiCuratedProfileWaveDropsPage } from '@/api/generated/models/ApiCuratedProfileWaveDropsPage';
import { DEFAULT_MAX_SIZE } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { dropsService } from '@/api/drops/drops.api.service';

const router = asyncRouter();

const DEFAULT_CURATED_PROFILE_WAVE_DROPS_PAGE_SIZE = 100;

interface GetCuratedProfileWaveDropsRequest {
  page: number;
  page_size: number;
}

const GetCuratedProfileWaveDropsRequestSchema =
  Joi.object<GetCuratedProfileWaveDropsRequest>({
    page: Joi.number().integer().default(1).min(1),
    page_size: Joi.number()
      .integer()
      .default(DEFAULT_CURATED_PROFILE_WAVE_DROPS_PAGE_SIZE)
      .max(DEFAULT_MAX_SIZE)
      .min(1)
  });

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, GetCuratedProfileWaveDropsRequest>,
    res: Response<ApiResponse<ApiCuratedProfileWaveDropsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request = getValidatedByJoiOrThrow(
      req.query,
      GetCuratedProfileWaveDropsRequestSchema
    );
    const result = await dropsService.findCuratedProfileWaveDrops(request, {
      authenticationContext,
      timer
    });
    res.send(result);
  }
);

export default router;
