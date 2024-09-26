import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { asyncRouter } from '../async.router';
import * as Joi from 'joi';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { UnauthorisedException } from '../../../exceptions';
import { RegisterPushNotificationTokenRequest } from 'src/generated/models/RegisterPushNotificationTokenRequest';

const registerPushNotificationTokenRequestSchema: Joi.ObjectSchema<RegisterPushNotificationTokenRequest> =
  Joi.object({
    token: Joi.string().required(),
    device_id: Joi.string().required(),
    profile_id: Joi.string().optional()
  });

const router = asyncRouter();

router.post(
  `/register`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<any, any, RegisterPushNotificationTokenRequest, any, any>,
    res: Response<
      ApiResponse<{
        success: boolean;
      }>
    >
  ) {
    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      registerPushNotificationTokenRequestSchema
    );

    const { token, device_id, profile_id } = validatedRequest;

    if (profile_id) {
      const authenticationContext = await getAuthenticationContext(req);
      if (authenticationContext.authenticatedProfileId !== profile_id) {
        throw new UnauthorisedException(
          'Profile ID does not match authenticated profile'
        );
      }
    }

    res.status(201).send({
      success: true
    });
  }
);

export default router;
