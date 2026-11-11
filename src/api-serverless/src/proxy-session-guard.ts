import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';

/**
 * Throws a ForbiddenException with the given message when the request is made
 * through a proxy session. Endpoints that only the profile owner may use call
 * this after resolving the acting profile.
 */
export function rejectProxySession(
  authenticationContext: AuthenticationContext | undefined,
  message: string
): void {
  if (authenticationContext?.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(message);
  }
}
