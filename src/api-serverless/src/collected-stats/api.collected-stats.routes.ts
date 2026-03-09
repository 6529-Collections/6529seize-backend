import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import { ApiCollectedStats } from '@/api/generated/models/ApiCollectedStats';
import { cacheRequest } from '@/api/request-cache';
import { collectedStatsService } from '@/api/collected-stats/api.collected-stats.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { Request, Response } from 'express';
import * as Joi from 'joi';

const router = asyncRouter();

const IdentityParamsSchema = Joi.object({
  identityKey: Joi.string().required()
});

router.get(
  '/:identityKey',
  cacheRequest(),
  async (
    req: Request<
      {
        identityKey: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiResponse<ApiCollectedStats>>
  ) => {
    const { identityKey } = getValidatedByJoiOrThrow(
      req.params,
      IdentityParamsSchema
    );
    const timer = Timer.getFromRequest(req);
    const result = await collectedStatsService.getStats(identityKey, {
      timer
    });
    return res.json(result);
  }
);

export default router;
