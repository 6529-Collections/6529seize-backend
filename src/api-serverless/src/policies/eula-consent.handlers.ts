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
import { getValidatedByJoiOrThrow } from '@/api/validation';
import * as Joi from 'joi';
import { CURRENT_EULA_VERSION } from './eula-policy';
import {
  deleteEULAConsent,
  fetchEULAConsent,
  saveEULAConsent
} from './policies.db';

const DeviceIdSchema = Joi.string().trim().min(1).max(100).required();

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

export async function handleSaveEulaConsent(
  req: SaveEulaConsentRequest
): Promise<ApiSaveEulaConsentResponse> {
  const body = getValidatedByJoiOrThrow(req.body, SaveEulaConsentBodySchema);
  await saveEULAConsent(body.device_id, body.platform, body.eula_version);
  return {
    message: 'EULA consent saved',
    eula_version: CURRENT_EULA_VERSION
  };
}

export async function handleDeleteEulaConsent(
  req: DeleteEulaConsentRequest
): Promise<ApiDeleteEulaConsentResponse> {
  const body = getValidatedByJoiOrThrow(req.body, DeleteEulaConsentBodySchema);
  await deleteEULAConsent(body.device_id);
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
