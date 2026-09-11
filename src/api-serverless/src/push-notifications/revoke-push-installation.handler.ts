import * as Joi from 'joi';
import { ApiRevokePushInstallationRequest } from '@/api/generated/models/ApiRevokePushInstallationRequest';
import { ApiRevokePushInstallationResponse } from '@/api/generated/models/ApiRevokePushInstallationResponse';
import { RevokePushInstallationRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { withDeviceBadgeLock } from '@/pushNotificationsHandler/device-badge';
import { revokeInstallation } from './push-installation.db';
import { requestInstallationBadgeRefresh } from './push-notifications.service';

const schema: Joi.ObjectSchema<ApiRevokePushInstallationRequest> = Joi.object({
  device_id: Joi.string().max(100).required(),
  installation_secret: Joi.string().hex().length(64).required(),
  revision: Joi.number().integer().min(1).max(4294967294).required(),
  token: Joi.string().max(4096).optional(),
  profile_id: Joi.string().max(100).optional(),
  all_profiles: Joi.boolean().required(),
  sessions: Joi.array()
    .max(50)
    .items(
      Joi.object({
        address: Joi.string()
          .pattern(/^0x[0-9a-fA-F]{40}$/)
          .required(),
        native_refresh_token: Joi.string().max(1024).required()
      })
    )
    .required()
});

export async function handleRevokePushInstallation(
  req: RevokePushInstallationRequest
): Promise<ApiRevokePushInstallationResponse> {
  const request = getValidatedByJoiOrThrow(req.body, schema);
  // Coordinate deletion with final recipient validation/submission on both OSes.
  const installation = await withDeviceBadgeLock(
    { device_id: request.device_id, token: request.token ?? '' },
    () => revokeInstallation(request, {})
  );
  // The durable installation retains the last delivery target after its final
  // profile disappears. Enqueue failures propagate so the client's outbox retries.
  await requestInstallationBadgeRefresh(installation.device_id);
  return { revision: installation.revision };
}
