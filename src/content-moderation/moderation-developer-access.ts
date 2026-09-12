import { env } from '@/env';
import { ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';

export function isModerationDeveloper(
  profileId: string | null | undefined
): boolean {
  return (
    !!profileId &&
    env
      .getStringArray('DEVS_6529_MENTION_PROFILE_IDS', ',')
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(profileId)
  );
}

export function assertModerationDeveloper(ctx: RequestContext): string {
  const auth = ctx.authenticationContext;
  const id = auth?.getActingAsId();
  if (!auth || auth.isAuthenticatedAsProxy() || !isModerationDeveloper(id)) {
    throw new ForbiddenException('Developer access is required');
  }
  return id!;
}
