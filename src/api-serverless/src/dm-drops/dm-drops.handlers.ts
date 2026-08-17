import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDmDropsUnreadCount } from '@/api/generated/models/ApiDmDropsUnreadCount';
import { ApiDmUnreadSnapshot } from '@/api/generated/models/ApiDmUnreadSnapshot';
import {
  GetDmDropsUnreadRequest,
  GetDmUnreadSnapshotRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { getGroupsUserIsEligibleForReadContext } from '@/api/waves/wave-access.helpers';
import { ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import * as Joi from 'joi';
import { DbPoolName } from '@/db-query.options';

const GetDmDropsUnreadQuerySchema = Joi.object<Record<string, never>>({})
  .unknown(false)
  .required();

async function getDmUnreadRequestContext(
  req: GetDmDropsUnreadRequest | GetDmUnreadSnapshotRequest
) {
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

  return { ctx, eligibleGroups, identityId };
}

export async function handleGetDmDropsUnread(
  req: GetDmDropsUnreadRequest
): Promise<ApiDmDropsUnreadCount> {
  const { ctx, eligibleGroups, identityId } =
    await getDmUnreadRequestContext(req);
  const count = await wavesApiDb.countIdentityUnreadDmDrops(
    { identityId, eligibleGroups },
    ctx
  );

  return { count };
}

export async function handleGetDmUnreadSnapshot(
  req: GetDmUnreadSnapshotRequest
): Promise<ApiDmUnreadSnapshot> {
  const { ctx, eligibleGroups, identityId } =
    await getDmUnreadRequestContext(req);

  const conversations = await wavesApiDb.findDmUnreadConversationStates(
    { identityId, eligibleGroups },
    ctx,
    DbPoolName.WRITE
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
