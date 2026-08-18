import { getAuthenticationContext } from '@/api/auth/auth';
import {
  ApiProfilePreferences,
  ApiProfilePreferencesDirectMessagePolicyEnum,
  ApiProfilePreferencesNotificationLevelEnum
} from '@/api/generated/models/ApiProfilePreferences';
import {
  GetProfilePreferencesRequest,
  PutProfilePreferencesRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  ProfileDirectMessagePolicy,
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';
import { ForbiddenException } from '@/exceptions';
import { profilePreferencesDb } from '@/profile-preferences/profile-preferences.db';
import { Timer } from '@/time';
import * as Joi from 'joi';

const notificationsSchema = Joi.object({
  direct_messages: Joi.boolean().optional(),
  mentions_replies_quotes: Joi.boolean().optional(),
  reactions_votes_boosts: Joi.boolean().optional(),
  new_followers: Joi.boolean().optional(),
  rep_and_nic: Joi.boolean().optional(),
  subscription_coverage: Joi.boolean().optional()
}).unknown(false);

const updateSchema = Joi.object({
  direct_message_policy: Joi.string()
    .valid(...Object.values(ProfileDirectMessagePolicy))
    .optional(),
  notification_level: Joi.string()
    .valid(...Object.values(ProfileNotificationLevel))
    .optional(),
  notifications: notificationsSchema.optional()
})
  .min(1)
  .unknown(false);

async function getProfileId(
  req: GetProfilePreferencesRequest | PutProfilePreferencesRequest
): Promise<string> {
  const authenticationContext = await getAuthenticationContext(
    req,
    Timer.getFromRequest(req)
  );
  const profileId = authenticationContext.getActingAsId();
  if (!profileId) {
    throw new ForbiddenException(
      'You need to create a profile before you can manage profile preferences'
    );
  }
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException('Proxies cannot manage profile preferences');
  }
  return profileId;
}

function toApiPreferences(
  preferences: ProfilePreferencesData
): ApiProfilePreferences {
  return {
    ...preferences,
    direct_message_policy:
      preferences.direct_message_policy as unknown as ApiProfilePreferencesDirectMessagePolicyEnum,
    notification_level:
      preferences.notification_level as unknown as ApiProfilePreferencesNotificationLevelEnum
  };
}

export async function handleGetProfilePreferences(
  req: GetProfilePreferencesRequest
): Promise<ApiProfilePreferences> {
  return toApiPreferences(
    await profilePreferencesDb.get(await getProfileId(req))
  );
}

export async function handlePutProfilePreferences(
  req: PutProfilePreferencesRequest
): Promise<ApiProfilePreferences> {
  const update = getValidatedByJoiOrThrow(
    req.body,
    updateSchema
  ) as Partial<ProfilePreferencesData>;
  return toApiPreferences(
    await profilePreferencesDb.upsert(await getProfileId(req), update)
  );
}
