import * as Joi from 'joi';
import { ApiRefreshPushInstallationBadgeRequest } from '@/api/generated/models/ApiRefreshPushInstallationBadgeRequest';
import { ApiRefreshPushInstallationBadgeResponse } from '@/api/generated/models/ApiRefreshPushInstallationBadgeResponse';
import { RefreshPushInstallationBadgeRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { verifyBadgeRefreshInstallation } from './push-installation-badge.db';
import {
  isActivated,
  requestInstallationBadgeRefresh
} from './push-notifications.service';

const schema: Joi.ObjectSchema<ApiRefreshPushInstallationBadgeRequest> =
  Joi.object({
    device_id: Joi.string().max(100).required(),
    installation_secret: Joi.string().hex().length(64).required(),
    revision: Joi.number().integer().min(0).max(4294967295).required()
  });

export async function handleRefreshPushInstallationBadge(
  req: RefreshPushInstallationBadgeRequest
): Promise<ApiRefreshPushInstallationBadgeResponse> {
  const request = getValidatedByJoiOrThrow(req.body, schema);
  await verifyBadgeRefreshInstallation(request);
  if (!isActivated()) return { queued: false };
  // The worker recounts current registrations/read state at delivery time,
  // including any logout or new notification after credential verification.
  await requestInstallationBadgeRefresh(request.device_id);
  return { queued: true };
}
