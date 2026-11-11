import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { dropsService } from './drops.api.service';
import { Timer } from '@/time';
import { ApiLightDrop } from '../generated/models/ApiLightDrop';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';

const router = asyncRouter();

const LIGHT_DROPS_LIMIT_MESSAGE = 'parsedLimit must be between 1 and 2000';

interface LightDropsQuery {
  wave_id?: string;
  limit: number;
  min_serial_no?: number | '' | null;
  max_serial_no?: number | '' | null;
  older_first: boolean;
}

const SerialNoSchema = Joi.number().integer().allow('', null).optional();

export const LightDropsQuerySchema: Joi.ObjectSchema<LightDropsQuery> =
  Joi.object<LightDropsQuery>({
    wave_id: Joi.string().guid().allow('').optional(),
    limit: Joi.number().integer().min(1).max(2000).required().messages({
      'any.required': 'limit must be provided',
      'number.base': LIGHT_DROPS_LIMIT_MESSAGE,
      'number.integer': LIGHT_DROPS_LIMIT_MESSAGE,
      'number.min': LIGHT_DROPS_LIMIT_MESSAGE,
      'number.max': LIGHT_DROPS_LIMIT_MESSAGE
    }),
    min_serial_no: SerialNoSchema,
    max_serial_no: SerialNoSchema,
    older_first: Joi.boolean().default(false)
  }).unknown(true);

function serialNoOrNull(value: number | '' | null | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        wave_id?: string;
        limit: number;
        min_serial_no: number | null;
        max_serial_no: number | null;
        older_first?: string;
      },
      any
    >,
    res: Response<ApiResponse<ApiLightDrop[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const query = getValidatedByJoiOrThrow(req.query, LightDropsQuerySchema);
    const latestDrops = await dropsService.findLightDrops(
      {
        waveId: query.wave_id || null,
        limit: query.limit,
        max_serial_no: serialNoOrNull(query.max_serial_no),
        min_serial_no: serialNoOrNull(query.min_serial_no),
        older_first: query.older_first
      },
      { timer, authenticationContext }
    );
    res.send(latestDrops);
  }
);

export default router;
