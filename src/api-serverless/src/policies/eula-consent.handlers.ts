import { ApiDeleteEulaConsentRequest } from '@/api/generated/models/ApiDeleteEulaConsentRequest';
import { ApiDeleteEulaConsentResponse } from '@/api/generated/models/ApiDeleteEulaConsentResponse';
import { ApiEulaConsent } from '@/api/generated/models/ApiEulaConsent';
import { ApiSaveEulaConsentRequest } from '@/api/generated/models/ApiSaveEulaConsentRequest';
import { ApiSaveEulaConsentResponse } from '@/api/generated/models/ApiSaveEulaConsentResponse';
import {
  DeleteEulaConsentRequest,
  GetEulaConsentRequest,
  SaveEulaConsentRequest
} from '@/api/generated/routes/operations';
import { getAuthenticationContext } from '@/api/auth/auth';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Request } from 'express';
import * as Joi from 'joi';
import { CURRENT_EULA_VERSION } from './eula-policy';
import {
  deleteOwnedEULAConsent,
  fetchEULAConsent,
  saveEULAConsent
} from './policies.db';

// Native device identifiers (vendor UUIDs, hex ids) use only these characters.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const DeviceIdSchema = Joi.string()
  .trim()
  .min(1)
  .max(100)
  .pattern(DEVICE_ID_PATTERN)
  .required();

const EulaConsentPathSchema = Joi.object<{ deviceId: string }>({
  deviceId: DeviceIdSchema
}).unknown(false);

const SaveEulaConsentBodySchema: Joi.ObjectSchema<ApiSaveEulaConsentRequest> =
  Joi.object<ApiSaveEulaConsentRequest>({
    device_id: DeviceIdSchema,
    platform: Joi.string().trim().min(1).max(32).required(),
    eula_version: Joi.string().valid(CURRENT_EULA_VERSION).required()
  }).unknown(false);

const DeleteEulaConsentBodySchema: Joi.ObjectSchema<ApiDeleteEulaConsentRequest> =
  Joi.object<ApiDeleteEulaConsentRequest>({
    device_id: DeviceIdSchema
  }).unknown(false);

/**
 * The caller's own profile id, or null for anonymous callers, wallets without
 * a profile and proxy tokens (proxies do not act on profile-scoped records).
 */
async function getCallerProfileIdOrNull(
  req: Request<any, any, any, any, any>
): Promise<string | null> {
  const authenticationContext = await getAuthenticationContext(req);
  if (authenticationContext.isAuthenticatedAsProxy()) {
    return null;
  }
  return authenticationContext.getActingAsId();
}

export async function handleSaveEulaConsent(
  req: SaveEulaConsentRequest
): Promise<ApiSaveEulaConsentResponse> {
  const body = getValidatedByJoiOrThrow(req.body, SaveEulaConsentBodySchema);
  const profileId = await getCallerProfileIdOrNull(req);
  await saveEULAConsent(
    body.device_id,
    body.platform,
    body.eula_version,
    profileId
  );
  return {
    message: 'EULA consent saved',
    eula_version: CURRENT_EULA_VERSION
  };
}

/**
 * Removes the device's consent when the caller owns it. Records that are
 * missing, unowned or owned by another profile are left in place and get the
 * same response, so the outcome does not reveal which case applied.
 */
export async function handleDeleteEulaConsent(
  req: DeleteEulaConsentRequest
): Promise<ApiDeleteEulaConsentResponse> {
  const body = getValidatedByJoiOrThrow(req.body, DeleteEulaConsentBodySchema);
  const profileId = await getCallerProfileIdOrNull(req);
  if (profileId) {
    await deleteOwnedEULAConsent(body.device_id, profileId);
  }
  return { message: 'EULA consent deleted' };
}

export async function handleGetEulaConsent(
  req: GetEulaConsentRequest
): Promise<ApiEulaConsent> {
  const { deviceId } = getValidatedByJoiOrThrow(
    req.params,
    EulaConsentPathSchema
  );
  const consent = await fetchEULAConsent(deviceId);
  return consent
    ? {
        device_id: consent.device_id,
        platform: consent.platform,
        accepted_at: consent.accepted_at,
        eula_version: CURRENT_EULA_VERSION
      }
    : {};
}
