import { getAuthenticationContext } from '@/api/auth/auth';
import type { ApiProfileWaveActivityPage } from '@/api/generated/models/ApiProfileWaveActivityPage';
import { ApiProfileWaveActivityType } from '@/api/generated/models/ApiProfileWaveActivityType';
import type { GetProfileWaveActivityRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { profileWaveActivityApiService } from '@/api/waves/profile-wave-activity.api.service';
import { Timer } from '@/time';
import * as Joi from 'joi';

interface ProfileWaveActivityPathParams {
  readonly identity: string;
}

interface ProfileWaveActivityQuery {
  readonly activity_type: ApiProfileWaveActivityType;
  readonly limit: number;
  readonly cursor?: string;
}

const ProfileWaveActivityPathParamsSchema: Joi.ObjectSchema<ProfileWaveActivityPathParams> =
  Joi.object({
    identity: Joi.string().trim().min(1).max(200).required()
  });

const ProfileWaveActivityQuerySchema: Joi.ObjectSchema<ProfileWaveActivityQuery> =
  Joi.object({
    activity_type: Joi.string()
      .uppercase()
      .valid(...Object.values(ApiProfileWaveActivityType))
      .required(),
    limit: Joi.number().integer().min(1).max(50).default(20),
    cursor: Joi.string().trim().min(1).max(2000).optional()
  }).unknown(false);

export async function handleGetProfileWaveActivity(
  req: GetProfileWaveActivityRequest
): Promise<ApiProfileWaveActivityPage> {
  const { identity } = getValidatedByJoiOrThrow(
    req.params,
    ProfileWaveActivityPathParamsSchema
  );
  const { activity_type, limit, cursor } = getValidatedByJoiOrThrow(
    req.query,
    ProfileWaveActivityQuerySchema
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return await profileWaveActivityApiService.getProfileWaveActivity(
    {
      identity,
      activityType: activity_type,
      limit,
      cursor
    },
    { authenticationContext, timer }
  );
}
