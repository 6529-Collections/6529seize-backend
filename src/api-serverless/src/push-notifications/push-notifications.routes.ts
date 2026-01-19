import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { asyncRouter } from '../async.router';
import * as Joi from 'joi';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { ForbiddenException, UnauthorisedException } from '../../../exceptions';
import { ApiRegisterPushNotificationTokenRequest } from '../generated/models/ApiRegisterPushNotificationTokenRequest';
import { PushNotificationDevice } from '../../../entities/IPushNotification';
import { savePushNotificationDevice } from './push-notifications.db';
import {
  getPushNotificationSettings,
  upsertPushNotificationSettings
} from './push-notification-settings.db';
import { PushNotificationSettingsData } from '../../../entities/IPushNotificationSettings';

const registerPushNotificationTokenRequestSchema: Joi.ObjectSchema<ApiRegisterPushNotificationTokenRequest> =
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
    req: Request<any, any, ApiRegisterPushNotificationTokenRequest, any, any>,
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

const settingsSchema: Joi.ObjectSchema<Partial<PushNotificationSettingsData>> =
  Joi.object({
    identity_subscribed: Joi.boolean().optional(),
    identity_mentioned: Joi.boolean().optional(),
    identity_rep: Joi.boolean().optional(),
    identity_cic: Joi.boolean().optional(),
    drop_quoted: Joi.boolean().optional(),
    drop_replied: Joi.boolean().optional(),
    drop_voted: Joi.boolean().optional(),
    drop_reacted: Joi.boolean().optional(),
    drop_boosted: Joi.boolean().optional(),
    wave_created: Joi.boolean().optional()
  });

router.get(
  `/settings/:device_id`,
  needsAuthenticatedUser(),
  async function (
    req: Request<{ device_id: string }, any, any, any, any>,
    res: Response<ApiResponse<PushNotificationSettingsData>>
  ) {
    const authenticationContext = await getAuthenticationContext(req);
    const profileId = authenticationContext.getActingAsId();
    if (!profileId) {
      throw new ForbiddenException(
        'You need to create a profile to access push notification settings'
      );
    }

    const deviceId = req.params.device_id;
    const settings = await getPushNotificationSettings(profileId, deviceId);

    res.send(settings);
  }
);

router.put(
  `/settings/:device_id`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      { device_id: string },
      any,
      Partial<PushNotificationSettingsData>,
      any,
      any
    >,
    res: Response<ApiResponse<PushNotificationSettingsData>>
  ) {
    const authenticationContext = await getAuthenticationContext(req);
    const profileId = authenticationContext.getActingAsId();
    if (!profileId) {
      throw new ForbiddenException(
        'You need to create a profile to update push notification settings'
      );
    }

    const deviceId = req.params.device_id;
    const validatedSettings = getValidatedByJoiOrThrow(
      req.body,
      settingsSchema
    );

    const updatedSettings = await upsertPushNotificationSettings(
      profileId,
      deviceId,
      validatedSettings
    );

    res.send(updatedSettings);
  }
);

export default router;
