import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ForbiddenException } from '@/exceptions';
import { assertProxyMayEditDrops } from './drop-proxy-rights';

function proxyContext(actions: ProfileProxyActionType[]) {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: 'grantor-profile',
    activeProxyActions: actions.map((type, index) => ({
      id: `action-${index}`,
      type,
      credit_amount: null,
      credit_spent: null
    }))
  });
}

describe('assertProxyMayEditDrops', () => {
  it('lets a direct session edit', () => {
    expect(() =>
      assertProxyMayEditDrops(AuthenticationContext.fromProfileId('author'))
    ).not.toThrow();
  });

  it('lets a proxy with the drop creation action edit', () => {
    expect(() =>
      assertProxyMayEditDrops(
        proxyContext([ProfileProxyActionType.CREATE_DROP_TO_WAVE])
      )
    ).not.toThrow();
  });

  it.each(
    Object.values(ProfileProxyActionType).filter(
      (it) => it !== ProfileProxyActionType.CREATE_DROP_TO_WAVE
    )
  )(
    'requires the drop creation action from a proxy holding only %s',
    (type) => {
      expect(() => assertProxyMayEditDrops(proxyContext([type]))).toThrow(
        new ForbiddenException(`Proxy doesn't have permission to edit drops`)
      );
    }
  );

  it('requires the drop creation action from a proxy without actions', () => {
    expect(() => assertProxyMayEditDrops(proxyContext([]))).toThrow(
      ForbiddenException
    );
  });
});
