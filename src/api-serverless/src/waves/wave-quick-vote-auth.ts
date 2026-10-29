import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ForbiddenException } from '@/exceptions';

export function getQuickVoteIdentity(context: AuthenticationContext): string {
  const identityId = context.getActingAsId();
  if (!identityId) {
    throw new ForbiddenException('Please create a profile first');
  }
  if (
    context.isAuthenticatedAsProxy() &&
    !context.hasProxyAction(ProfileProxyActionType.READ_WAVE) &&
    !context.hasProxyAction(ProfileProxyActionType.RATE_WAVE_DROP)
  ) {
    throw new ForbiddenException(
      "Proxy doesn't have permission to use quick vote"
    );
  }
  return identityId;
}
