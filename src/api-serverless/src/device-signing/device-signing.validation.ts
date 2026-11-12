import * as Joi from 'joi';
import { BadRequestException } from '@/exceptions';
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
      // v2 (D172): a canonical suite set, [] without an MLS key.
      version: Joi.number().integer().valid(1, 2).optional(),
      ciphersuites: Joi.array()
        .items(Joi.number().integer().min(1).max(0xffff))
        .max(4)
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

/** Longest drop id accepted in a batch read (the drops.id column length). */
const DROP_ID_MAX_LENGTH = 100;

/**
 * The `drop_ids` query of GET /drops/signed-events: comma separated, 1 to
 * `maxDrops` non-empty ids (a repeated parameter is read as one list).
 * Returns the distinct ids in request order.
 */
export function parseDropSignedEventsBatchIds(
  value: unknown,
  maxDrops: number
): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (
    !values.length ||
    values.some((it) => typeof it !== 'string' || !it.trim().length)
  ) {
    throw new BadRequestException(
      `drop_ids is required: a comma separated list of 1 to ${maxDrops} drop ids`
    );
  }
  const ids = values.flatMap((it: string) =>
    it.split(',').map((id) => id.trim())
  );
  if (ids.some((id) => !id.length || id.length > DROP_ID_MAX_LENGTH)) {
    throw new BadRequestException(
      `drop_ids must not contain empty ids or ids longer than ${DROP_ID_MAX_LENGTH} characters`
    );
  }
  if (ids.length > maxDrops) {
    throw new BadRequestException(
      `drop_ids lists ${ids.length} ids; at most ${maxDrops} are allowed`
    );
  }
  return Array.from(new Set(ids));
}
