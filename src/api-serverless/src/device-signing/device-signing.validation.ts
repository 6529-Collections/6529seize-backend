import * as Joi from 'joi';
import { ApiRegisterDeviceGrantRequest } from '@/api/generated/models/ApiRegisterDeviceGrantRequest';
import { E2EE_WALLET_SIGNATURE_PATTERN } from '@/e2ee/e2ee-encoding';
import { APP_DEVICE_GRANT_ORIGIN_MAX_LENGTH } from './app-device-grant';
import {
  DEVICE_GRANT_SCOPES,
  DEVICE_LABEL_MAX_LENGTH
} from './device-grant-message';

export const deviceLabelRenameSchema = Joi.object<{ label: string }>({
  label: Joi.string()
    .trim()
    .min(1)
    .max(DEVICE_LABEL_MAX_LENGTH)
    .pattern(/^[A-Za-z0-9 ._()-]+$/)
    .required()
}).required();

const hex32 = () => Joi.string().pattern(/^0x[0-9a-fA-F]{64}$/);
const unixSeconds = () =>
  Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER);

export const registerDeviceGrantSchema =
  Joi.object<ApiRegisterDeviceGrantRequest>({
    grant: Joi.object({
      wallet: Joi.string()
        .pattern(/^0x[0-9a-fA-F]{40}$/)
        .required(),
      device_key: hex32().required(),
      scopes: Joi.array()
        .items(Joi.string().valid(...DEVICE_GRANT_SCOPES))
        .min(1)
        .max(DEVICE_GRANT_SCOPES.length)
        .required(),
      mls_device_key: hex32().allow(null).optional(),
      ciphersuite: Joi.number()
        .integer()
        .min(1)
        .max(0xffff)
        .allow(null)
        .optional(),
      issued_at: unixSeconds().required(),
      expires_at: unixSeconds().required(),
      origin: Joi.string()
        .min(1)
        .max(APP_DEVICE_GRANT_ORIGIN_MAX_LENGTH)
        .required()
    }).required(),
    wallet_signature: Joi.string()
      .pattern(E2EE_WALLET_SIGNATURE_PATTERN)
      .max(20002)
      .required(),
    device_label: Joi.string().allow('').max(200).optional()
  });
