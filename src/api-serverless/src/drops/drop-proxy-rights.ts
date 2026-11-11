import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ForbiddenException } from '@/exceptions';

/**
 * Editing a drop through a proxy needs the same proxy action as creating one.
 */
export function assertProxyMayEditDrops(
  authenticationContext: AuthenticationContext | undefined
): void {
  if (
    authenticationContext?.isAuthenticatedAsProxy() &&
    !authenticationContext.hasProxyAction(
      ProfileProxyActionType.CREATE_DROP_TO_WAVE
    )
  ) {
    throw new ForbiddenException(`Proxy doesn't have permission to edit drops`);
  }
}
