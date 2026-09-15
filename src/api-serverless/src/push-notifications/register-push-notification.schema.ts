import * as Joi from 'joi';
import { ApiRegisterPushNotificationTokenRequest } from '../generated/models/ApiRegisterPushNotificationTokenRequest';

export const registerPushNotificationTokenRequestSchema: Joi.ObjectSchema<ApiRegisterPushNotificationTokenRequest> =
  Joi.object({
    device_id: Joi.string().required(),
    token: Joi.string().required(),
    profile_id: Joi.string().optional(),
    platform: Joi.string().optional(),
    installation_secret: Joi.string().hex().length(64).optional(),
    installation_revision: Joi.number()
      .integer()
      .min(0)
      .max(4294967295)
      .optional()
  }).and('installation_secret', 'installation_revision');
