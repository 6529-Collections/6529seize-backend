import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ApiWave } from '../generated/models/ApiWave';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import { waveApiService, WavesOverviewParams } from './wave.api.service';
import { ApiWavesOverviewType } from '../generated/models/ApiWavesOverviewType';
import { Timer } from '../../../time';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, WavesOverviewParams, any>,
    res: Response<ApiResponse<ApiWave[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const params = getValidatedByJoiOrThrow(
      req.query,
      WavesOverviewParamsSchema
    );
    const waves = await waveApiService.getWavesOverview(params, {
      authenticationContext,
      timer
    });
    res.send(waves);
  }
);

const WavesOverviewParamsSchema = Joi.object<WavesOverviewParams>({
  limit: Joi.number().integer().optional().min(1).max(20).default(10),
  offset: Joi.number().integer().optional().min(0).default(0),
  type: Joi.string()
    .required()
    .allow(...Object.values(ApiWavesOverviewType)),
  only_waves_followed_by_authenticated_user: Joi.boolean()
    .optional()
    .default(false),
  direct_message: Joi.boolean().truthy('true').falsy('false').optional()
});

export default router;
