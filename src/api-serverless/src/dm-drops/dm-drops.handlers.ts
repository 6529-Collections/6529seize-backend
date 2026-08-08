import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDmUnreadSnapshot } from '@/api/generated/models/ApiDmUnreadSnapshot';
import { GetDmDropsUnreadRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { getGroupsUserIsEligibleForReadContext } from '@/api/waves/wave-access.helpers';
import { ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import * as Joi from 'joi';

const GetDmDropsUnreadQuerySchema = Joi.object<Record<string, never>>({})
  .unknown(false)
  .required();

export async function handleGetDmDropsUnread(
  req: GetDmDropsUnreadRequest
): Promise<ApiDmUnreadSnapshot> {
  const timer = Timer.getFromRequest(req);
  getValidatedByJoiOrThrow(req.query, GetDmDropsUnreadQuerySchema);

  const authenticationContext = await getAuthenticationContext(req, timer);
  const identityId = authenticationContext.getActingAsId();
  if (!identityId) {
    throw new ForbiddenException(
      `You need to create a profile before you can access direct messages`
    );
  }

  const ctx = { timer, authenticationContext };
  const eligibleGroups = await getGroupsUserIsEligibleForReadContext(
    userGroupsService,
    ctx
  );

  const conversations = await wavesApiDb.findDmUnreadConversationStates(
    { identityId, eligibleGroups },
    ctx
  );

  return {
    profile_id: identityId,
    count: conversations.reduce(
      (total, conversation) => total + conversation.unread_count,
      0
    ),
    conversations
  };
}
