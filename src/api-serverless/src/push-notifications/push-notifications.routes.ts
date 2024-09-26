import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { asyncRouter } from '../async.router';
import * as Joi from 'joi';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { UnauthorisedException } from '../../../exceptions';
import { RegisterPushNotificationTokenRequest } from '../generated/models/RegisterPushNotificationTokenRequest';
import { PushNotificationDevice } from '../../../entities/IPushNotification';
import { savePushNotificationDevice } from './push-notifications.db';

const registerPushNotificationTokenRequestSchema: Joi.ObjectSchema<RegisterPushNotificationTokenRequest> =
  Joi.object({
    device_id: Joi.string().required(),
    token: Joi.string().required(),
    profile_id: Joi.string().optional(),
    platform: Joi.string().optional()
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

    const { token, device_id, profile_id, platform } = validatedRequest;

    if (profile_id) {
      const authenticationContext = await getAuthenticationContext(req);
      if (authenticationContext.authenticatedProfileId !== profile_id) {
        console.log(
          'authenticatedProfileId',
          authenticationContext.authenticatedProfileId
        );
        console.log('profile_id', profile_id);
        throw new UnauthorisedException(
          'Profile ID does not match authenticated profile'
        );
      }
    }

    const pushNotificationDevice: PushNotificationDevice = {
      device_id,
      token,
      platform,
      profile_id
    };

    await savePushNotificationDevice(pushNotificationDevice);

    res.status(201).send({
      success: true
    });
  }
);

export default router;
