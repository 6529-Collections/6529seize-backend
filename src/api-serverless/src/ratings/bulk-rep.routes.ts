import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ratingsService } from '../../../rates/ratings.service';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { WALLET_REGEX } from '@/constants';
import { ApiBulkRepRequest } from '../generated/models/ApiBulkRepRequest';
import { Timer } from '../../../time';
import { ApiBulkRepTarget } from '../generated/models/ApiBulkRepTarget';

const router = asyncRouter();

router.post(
  `/`,
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, ApiBulkRepRequest, any, any>,
    res: Response<ApiResponse<any>>
  ) {
    const timer = Timer.getFromRequest(req);
    const apiRequest = getValidatedByJoiOrThrow(req.body, BulkRepRequestSchema);
    const authenticationContext = await getAuthenticationContext(req, timer);
    await ratingsService.bulkRep(apiRequest, { timer, authenticationContext });
    res.send({}).status(201);
  }
);

const BulkRepTargetSchema: Joi.ObjectSchema<ApiBulkRepTarget> =
  Joi.object<ApiBulkRepTarget>({
    address: Joi.string()
      .required()
      .regex(WALLET_REGEX)
      .messages({
        'string.pattern.base': `Invalid address.`
      })
      .lowercase(),
    category: Joi.string()
      .required()
      .min(1)
      .max(100)
      .regex(REP_CATEGORY_PATTERN)
      .messages({
        'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
      }),
    amount: Joi.number().integer().required()
  });

const BulkRepRequestSchema: Joi.ObjectSchema<ApiBulkRepRequest> =
  Joi.object<ApiBulkRepRequest>({
    targets: Joi.array().items(BulkRepTargetSchema).required()
  });

export default router;
