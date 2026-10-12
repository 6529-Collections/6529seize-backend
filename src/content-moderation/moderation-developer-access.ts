import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { isDevTeamMember } from '@/groups/dev-team-access';

export { DEV_TEAM_GROUP_ID as MODERATION_DEVELOPER_GROUP_ID } from '@/groups/dev-team-access';

export async function isModerationDeveloper(
  profileId: string | null | undefined,
  ctx: RequestContext
): Promise<boolean> {
  try {
    return await isDevTeamMember(profileId, ctx);
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
