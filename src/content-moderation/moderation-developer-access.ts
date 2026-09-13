import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';

export const MODERATION_DEVELOPER_GROUP_ID =
  '6529-dev-team-xuahLBqRGQr6yX9R5yna4V';

export async function isModerationDeveloper(
  profileId: string | null | undefined,
  ctx: RequestContext
): Promise<boolean> {
  const auth = ctx.authenticationContext;
  if (
    !profileId ||
    !auth?.isUserFullyAuthenticated() ||
    auth.isAuthenticatedAsProxy() ||
    auth.getActingAsId() !== profileId
  ) {
    return false;
  }
  try {
    // Load lazily: the group service also uses moderation services. The
    // targeted eligibility path reads current definitions and predicates,
    // without the cross-request eligible-group or group-definition caches.
    const { userGroupsService } =
      await import('@/api/community-members/user-groups.service');
    const eligible = await userGroupsService.getGroupsUserIsEligibleForByIds(
      profileId,
      [MODERATION_DEVELOPER_GROUP_ID],
      ctx.timer
    );
    return eligible.includes(MODERATION_DEVELOPER_GROUP_ID);
  } catch {
    Logger.get('ModerationDeveloperAccess').error(
      'Unable to verify moderation developer group eligibility'
    );
    throw new CustomApiCompliantException(
      503,
      'Moderation access is temporarily unavailable',
      'MODERATION_ACCESS_UNAVAILABLE'
    );
  }
}

export async function assertModerationDeveloper(
  ctx: RequestContext
): Promise<string> {
  const id = ctx.authenticationContext?.getActingAsId();
  if (!(await isModerationDeveloper(id, ctx))) {
    throw new ForbiddenException('6529 Dev Team membership is required');
  }
  return id!;
}
