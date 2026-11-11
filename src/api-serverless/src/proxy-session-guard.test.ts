import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { rejectProxySession } from '@/api/proxy-session-guard';

function contextWithProxy(isProxy: boolean): AuthenticationContext {
  return {
    isAuthenticatedAsProxy: () => isProxy
  } as unknown as AuthenticationContext;
}

describe('rejectProxySession', () => {
  it('throws the given message for proxy sessions', () => {
    expect(() =>
      rejectProxySession(contextWithProxy(true), 'Proxies cannot do this')
    ).toThrow(new ForbiddenException('Proxies cannot do this'));
  });

  it('allows direct sessions', () => {
    expect(() =>
      rejectProxySession(contextWithProxy(false), 'Proxies cannot do this')
    ).not.toThrow();
  });

  it('allows requests without an authentication context', () => {
    expect(() =>
      rejectProxySession(undefined, 'Proxies cannot do this')
    ).not.toThrow();
  });
});
