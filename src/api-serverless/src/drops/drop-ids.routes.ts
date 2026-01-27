import { Request, Response } from 'express';
import * as Joi from 'joi';
import { Timer } from '../../../time';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { ApiDropId } from '../generated/models/ApiDropId';
import { getValidatedByJoiOrThrow } from '../validation';
import { dropsService } from './drops.api.service';

const router = asyncRouter();

const DropIdsQuerySchema = Joi.object({
  wave_id: Joi.string().required(),
  min_serial_no: Joi.number().integer().required(),
  max_serial_no: Joi.number().integer().optional(),
  limit: Joi.number().integer().min(1).max(5000).default(100)
});

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        wave_id: string;
        min_serial_no: number;
        max_serial_no?: number;
        limit?: number;
      },
      any
    >,
    res: Response<ApiResponse<ApiDropId[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { wave_id, min_serial_no, max_serial_no, limit } =
      getValidatedByJoiOrThrow(req.query, DropIdsQuerySchema);
    const dropIds = await dropsService.findDropIdsInWaveRange(
      {
        wave_id,
        min_serial_no,
        max_serial_no: max_serial_no ?? null,
        limit
      },
      { timer, authenticationContext }
    );
    res.send(dropIds);
  }
);

export default router;
