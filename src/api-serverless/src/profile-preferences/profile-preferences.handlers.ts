import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
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
  ProfilePreferencesData,
  ProfilePreferencesUpdate
} from '@/entities/IProfilePreferences';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { profilePreferencesDb } from '@/profile-preferences/profile-preferences.db';
import { RequestContext } from '@/request.context';
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
  direct_message_group_id: Joi.string().trim().min(1).max(200).allow(null),
  direct_message_allow_people_i_follow: Joi.boolean().optional(),
  notification_level: Joi.string()
    .valid(...Object.values(ProfileNotificationLevel))
    .optional(),
  notifications: notificationsSchema.optional()
})
  .min(1)
  .unknown(false);

const API_DIRECT_MESSAGE_POLICY: Record<
  ProfileDirectMessagePolicy,
  ApiProfilePreferencesDirectMessagePolicyEnum
> = {
  [ProfileDirectMessagePolicy.EVERYONE]:
    ApiProfilePreferencesDirectMessagePolicyEnum.Everyone,
  [ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW]:
    ApiProfilePreferencesDirectMessagePolicyEnum.PeopleIFollow,
  [ProfileDirectMessagePolicy.NOBODY]:
    ApiProfilePreferencesDirectMessagePolicyEnum.Nobody,
  [ProfileDirectMessagePolicy.GROUP_MEMBERS]:
    ApiProfilePreferencesDirectMessagePolicyEnum.GroupMembers
};

async function getProfileContext(
  req: GetProfilePreferencesRequest | PutProfilePreferencesRequest
): Promise<{ profileId: string; ctx: RequestContext }> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const profileId = authenticationContext.getActingAsId();
  if (!profileId) {
    throw new ForbiddenException(
      'You need to create a profile before you can manage profile preferences'
    );
  }
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException('Proxies cannot manage profile preferences');
  }
  return { profileId, ctx: { authenticationContext, timer } };
}

async function isDirectMessageGroupUnavailable(
  preferences: ProfilePreferencesData,
  ctx: RequestContext
): Promise<boolean> {
  if (
    preferences.direct_message_policy !==
    ProfileDirectMessagePolicy.GROUP_MEMBERS
  ) {
    return false;
  }
  return !(await userGroupsService.directMessageAdmission.isGroupUsable(
    preferences.direct_message_group_id,
    { timer: ctx.timer }
  ));
}

async function toApiPreferences(
  preferences: ProfilePreferencesData,
  ctx: RequestContext
): Promise<ApiProfilePreferences> {
  const notificationLevel = {
    [ProfileNotificationLevel.ALL]:
      ApiProfilePreferencesNotificationLevelEnum.All,
    [ProfileNotificationLevel.ESSENTIAL_ONLY]:
      ApiProfilePreferencesNotificationLevelEnum.EssentialOnly
  }[preferences.notification_level];

  return {
    direct_message_policy:
      API_DIRECT_MESSAGE_POLICY[preferences.direct_message_policy],
    direct_message_group_id: preferences.direct_message_group_id,
    direct_message_allow_people_i_follow:
      preferences.direct_message_allow_people_i_follow,
    direct_message_group_unavailable: await isDirectMessageGroupUnavailable(
      preferences,
      ctx
    ),
    notification_level: notificationLevel,
    notifications: preferences.notifications
  };
}

async function assertDirectMessageGroupSelectable(
  groupId: string,
  ctx: RequestContext
): Promise<void> {
  const [group] = await userGroupsService.getApiGroupsVisibleToRequesterByIds(
    [groupId],
    ctx
  );
  if (!group || group.is_direct_message) {
    throw new BadRequestException(
      'Choose a group you can see to limit who can message you.'
    );
  }
}

/**
 * GROUP_MEMBERS always needs a group: from this request or already saved.
 * Clearing the group while GROUP_MEMBERS stays selected is rejected.
 */
async function assertDirectMessageGroupUpdate(
  profileId: string,
  update: ProfilePreferencesUpdate,
  ctx: RequestContext
): Promise<void> {
  if (update.direct_message_group_id) {
    await assertDirectMessageGroupSelectable(
      update.direct_message_group_id,
      ctx
    );
  }
  const changesGroupRequirement =
    update.direct_message_policy !== undefined ||
    update.direct_message_group_id === null;
  if (!changesGroupRequirement) return;
  const stored = await profilePreferencesDb.get(profileId);
  const policy = update.direct_message_policy ?? stored.direct_message_policy;
  // null is meaningful here (it clears the group), so `??` would be wrong.
  const groupId =
    'direct_message_group_id' in update
      ? update.direct_message_group_id
      : stored.direct_message_group_id;
  if (policy === ProfileDirectMessagePolicy.GROUP_MEMBERS && !groupId) {
    throw new BadRequestException(
      'Choose a group to limit who can message you.'
    );
  }
}

export async function handleGetProfilePreferences(
  req: GetProfilePreferencesRequest
): Promise<ApiProfilePreferences> {
  const { profileId, ctx } = await getProfileContext(req);
  return toApiPreferences(await profilePreferencesDb.get(profileId), ctx);
}

export async function handlePutProfilePreferences(
  req: PutProfilePreferencesRequest
): Promise<ApiProfilePreferences> {
  const update = getValidatedByJoiOrThrow(
    req.body,
    updateSchema
  ) as ProfilePreferencesUpdate;
  const { profileId, ctx } = await getProfileContext(req);
  await assertDirectMessageGroupUpdate(profileId, update, ctx);
  return toApiPreferences(
    await profilePreferencesDb.upsert(profileId, update),
    ctx
  );
}
