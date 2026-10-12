import { RequestContext } from '@/request.context';

export const DEV_TEAM_GROUP_ID = '6529-dev-team-xuahLBqRGQr6yX9R5yna4V';

export async function isDevTeamMember(
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
  // The group service also imports moderation. Keep this dependency lazy and
  // use the targeted path, which reads current rules without membership caches.
  const { userGroupsService } =
    await import('@/api/community-members/user-groups.service');
  const eligible = await userGroupsService.getGroupsUserIsEligibleForByIds(
    profileId,
    [DEV_TEAM_GROUP_ID],
    ctx.timer
  );
  return eligible.includes(DEV_TEAM_GROUP_ID);
}
