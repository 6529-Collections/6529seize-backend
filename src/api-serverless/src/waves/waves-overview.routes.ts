import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { Wave } from '../generated/models/Wave';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import { waveApiService, WavesOverviewParams } from './wave.api.service';
import { WavesOverviewType } from '../generated/models/WavesOverviewType';

const router = asyncRouter();

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, WavesOverviewParams, any>,
    res: Response<ApiResponse<Wave[]>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const params = getValidatedByJoiOrThrow(
      req.query,
      WavesOverviewParamsSchema
    );
    const waves = await waveApiService.getWavesOverview(
      params,
      authenticationContext
    );
    res.send(waves);
  }
);

const WavesOverviewParamsSchema = Joi.object<WavesOverviewParams>({
  limit: Joi.number().integer().optional().min(1).max(20).default(10),
  offset: Joi.number().integer().optional().min(0).default(0),
  type: Joi.string()
    .required()
    .allow(...Object.values(WavesOverviewType))
});

export default router;
