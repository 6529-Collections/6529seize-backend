import fc from 'fast-check';
import { AuthenticationContext } from './auth-context';
import { ProfileProxyActionType } from './entities/IProfileProxyAction';

const GRANTOR = 'grantor-profile';
const GRANTEE = 'grantee-profile';

function proxyContext(
  actions: Array<{
    type: ProfileProxyActionType;
    wave_allowlist: readonly string[] | null;
  }>
): AuthenticationContext {
  return new AuthenticationContext({
    authenticatedWallet: '0xgrantee',
    authenticatedProfileId: GRANTEE,
    roleProfileId: GRANTOR,
    activeProxyActions: actions.map((action, index) => ({
      id: `action-${index}`,
      type: action.type,
      credit_amount: null,
      credit_spent: null,
      wave_allowlist: action.wave_allowlist
    }))
  });
}

describe('AuthenticationContext.hasRightsToPostInWave', () => {
  it('is false for anonymous and profile-less sessions', () => {
    expect(
      AuthenticationContext.notAuthenticated().hasRightsToPostInWave('wave-1')
    ).toBe(false);
    const walletOnly = new AuthenticationContext({
      authenticatedWallet: '0xabc',
      authenticatedProfileId: null,
      roleProfileId: null,
      activeProxyActions: []
    });
    expect(walletOnly.hasRightsToPostInWave('wave-1')).toBe(false);
  });

  it('is true in every wave for a user acting as themselves', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (waveId) => {
        expect(
          AuthenticationContext.fromProfileId(GRANTOR).hasRightsToPostInWave(
            waveId
          )
        ).toBe(true);
      })
    );
  });

  it('is false for a proxy without the CREATE_DROP_TO_WAVE grant', () => {
    const ctx = proxyContext([
      { type: ProfileProxyActionType.READ_WAVE, wave_allowlist: null }
    ]);
    expect(ctx.hasRightsToPostInWave('wave-1')).toBe(false);
    expect(ctx.isProxyBarredFromPostingInWave('wave-1')).toBe(true);
  });

  it('keeps a legacy (null) grant unrestricted', () => {
    const ctx = proxyContext([
      { type: ProfileProxyActionType.CREATE_DROP_TO_WAVE, wave_allowlist: null }
    ]);
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (waveId) => {
        expect(ctx.hasRightsToPostInWave(waveId)).toBe(true);
        expect(ctx.isProxyBarredFromPostingInWave(waveId)).toBe(false);
      })
    );
  });

  it('restricts a scoped grant to exactly its waves', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1 }),
        fc.string({ minLength: 1 }),
        (allowlist, probe) => {
          const ctx = proxyContext([
            {
              type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
              wave_allowlist: allowlist
            }
          ]);
          expect(ctx.hasRightsToPostInWave(probe)).toBe(
            allowlist.includes(probe)
          );
          expect(ctx.isProxyBarredFromPostingInWave(probe)).toBe(
            !allowlist.includes(probe)
          );
        }
      )
    );
  });

  it('treats an empty stored list as a grant that posts nowhere', () => {
    const ctx = proxyContext([
      { type: ProfileProxyActionType.CREATE_DROP_TO_WAVE, wave_allowlist: [] }
    ]);
    expect(ctx.hasRightsToPostInWave('wave-1')).toBe(false);
    expect(ctx.hasRightsTo(ProfileProxyActionType.CREATE_DROP_TO_WAVE)).toBe(
      true
    );
  });

  it('does not bar a non-proxy user from any wave', () => {
    expect(
      AuthenticationContext.fromProfileId(
        GRANTOR
      ).isProxyBarredFromPostingInWave('wave-1')
    ).toBe(false);
  });
});
