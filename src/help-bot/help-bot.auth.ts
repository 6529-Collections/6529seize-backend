import { AuthenticationContext } from '@/auth-context';
import { RequestContext } from '@/request.context';

export function withHelpBotAuthentication(
  botProfileId: string,
  ctx: RequestContext
): RequestContext {
  return {
    ...ctx,
    authenticationContext: AuthenticationContext.fromProfileId(botProfileId)
  };
}
