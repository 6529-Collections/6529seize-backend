import * as fc from 'fast-check';
import {
  accessTokenSessionOf,
  hasAccessTokenSessionClaims,
  LEGACY_ACCESS_TOKEN_SESSION,
  legacyLoginAccessTokenSession,
  readAccessTokenSessionClaims,
  toAccessTokenSessionClaims,
  toWalletAuthSignatureFormat
} from './access-token-session';

const SESSION_ID = '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e';

describe('access token session claims', () => {
  it('writes ct, sb and sid and reads them back', () => {
    const session = {
      clientType: 'web' as const,
      binding: 'siwe' as const,
      sessionId: SESSION_ID
    };
    const claims = toAccessTokenSessionClaims(session);
    expect(claims).toEqual({ ct: 'web', sb: 'siwe', sid: SESSION_ID });
    expect(readAccessTokenSessionClaims(claims)).toEqual(session);
  });

  it('leaves unknown parts out of the token', () => {
    expect(toAccessTokenSessionClaims(LEGACY_ACCESS_TOKEN_SESSION)).toEqual({
      ct: 'legacy'
    });
    expect(
      toAccessTokenSessionClaims({
        clientType: null,
        binding: null,
        sessionId: null
      })
    ).toEqual({});
  });

  it('reads a token minted before the claims existed as having none', () => {
    const session = readAccessTokenSessionClaims({
      id: 'x',
      sub: '0x0000000000000000000000000000000000000001',
      exp: 1
    });
    expect(session).toEqual({
      clientType: null,
      binding: null,
      sessionId: null
    });
    expect(hasAccessTokenSessionClaims(session)).toBe(false);
  });

  it('ignores claim values it does not know instead of failing', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.anything(),
        (ct, sb, sid) => {
          const session = readAccessTokenSessionClaims({ ct, sb, sid });
          expect([null, 'web', 'native', 'desktop', 'legacy']).toContain(
            session.clientType
          );
          expect([
            null,
            'siwe',
            'structured',
            'share',
            'legacy_text'
          ]).toContain(session.binding);
          expect(
            session.sessionId === null ||
              /^[0-9a-f-]{36}$/.test(session.sessionId)
          ).toBe(true);
        }
      )
    );
    expect(
      readAccessTokenSessionClaims({ ct: 'robot', sb: 'magic', sid: 'abc' })
    ).toEqual({ clientType: null, binding: null, sessionId: null });
  });

  it('takes the client type, signature format and id of a session row', () => {
    expect(
      accessTokenSessionOf({
        id: SESSION_ID,
        client_type: 'desktop',
        signature_format: 'share'
      })
    ).toEqual({
      clientType: 'desktop',
      binding: 'share',
      sessionId: SESSION_ID
    });
  });

  it('leaves the binding unknown for a session row stored before it was recorded', () => {
    expect(
      accessTokenSessionOf({ id: SESSION_ID, client_type: 'native' })
    ).toEqual({ clientType: 'native', binding: null, sessionId: SESSION_ID });
    expect(toWalletAuthSignatureFormat(null)).toBeNull();
    expect(toWalletAuthSignatureFormat('legacy_text')).toBeNull();
  });

  it('marks /auth/login tokens legacy, structured or plain text', () => {
    expect(
      legacyLoginAccessTokenSession('6529 Authentication\nVersion: 2\n')
    ).toEqual({ clientType: 'legacy', binding: 'structured', sessionId: null });
    expect(
      legacyLoginAccessTokenSession(
        '\nAre you ready to Seize The Memes of Production?\n'
      )
    ).toEqual({
      clientType: 'legacy',
      binding: 'legacy_text',
      sessionId: null
    });
  });
});
