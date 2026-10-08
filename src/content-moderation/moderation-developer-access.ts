import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { DEV_TEAM_GROUP_ID, isDevTeamMember } from '@/groups/dev-team-access';

export const MODERATION_DEVELOPER_GROUP_ID = DEV_TEAM_GROUP_ID;

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
