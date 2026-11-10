import * as fc from 'fast-check';
import * as jwt from 'jsonwebtoken';
import {
  getAccessTokenClaimsOrNull,
  getBearerTokenOrNull,
  getVerifiedAccessTokenWalletOrNull
} from './access-token-wallet';

const SECRET = 'access-token-wallet-test-secret';
const WALLET = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const resolveSecret = () => SECRET;

function sign(
  payload: string | object,
  options: jwt.SignOptions = { expiresIn: 60 },
  secret: string = SECRET
): string {
  return jwt.sign(payload, secret, options);
}

describe('getBearerTokenOrNull', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    ['BEARER   abc', 'abc'],
    ['  Bearer abc trailing', 'abc']
  ])('extracts the token from %p', (header, expected) => {
    expect(getBearerTokenOrNull(header)).toBe(expected);
  });

  it.each([undefined, null, 42, ['Bearer abc'], '', 'Bearer', 'Basic abc'])(
    'returns null for %p',
    (header) => {
      expect(getBearerTokenOrNull(header)).toBeNull();
    }
  );
});

describe('getVerifiedAccessTokenWalletOrNull', () => {
  it('returns the lowercase wallet for a valid access token', () => {
    const token = sign({ id: 'id', sub: WALLET, role: 'some-role' });

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, resolveSecret)
    ).toBe(WALLET.toLowerCase());
  });

  it('returns null for an expired token', () => {
    const token = sign(
      { sub: WALLET, exp: Math.floor(Date.now() / 1000) - 10 },
      {}
    );

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, resolveSecret)
    ).toBeNull();
  });

  it('returns null for a token signed with another secret', () => {
    const token = sign({ sub: WALLET }, { expiresIn: 60 }, 'other-secret');

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, resolveSecret)
    ).toBeNull();
  });

  it('returns null for a token signed with a non-pinned algorithm', () => {
    const token = sign({ sub: WALLET }, { expiresIn: 60, algorithm: 'HS512' });

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, resolveSecret)
    ).toBeNull();
  });

  it('returns null for an unsigned token', () => {
    const token = jwt.sign({ sub: WALLET }, '', { algorithm: 'none' });

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, resolveSecret)
    ).toBeNull();
  });

  it.each([
    ['a string payload', 'plain signed message'],
    ['a non-wallet subject', { sub: 'wallet-auth-session-challenge' }],
    ['no subject', { id: 'id' }],
    ['a numeric subject', { sub: 123 }],
    ['a challenge type', { sub: WALLET, challenge_type: 'wallet_auth' }],
    ['an issuer', { sub: WALLET, iss: 'issuer' }]
  ])('returns null for a signed token with %s', (_, payload) => {
    const options: jwt.SignOptions =
      typeof payload === 'string' ? {} : { expiresIn: 60 };
    const token = sign(payload, options);

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, resolveSecret)
    ).toBeNull();
  });

  it('does not resolve the secret when there is no Bearer token', () => {
    const resolver = jest.fn(resolveSecret);

    expect(getVerifiedAccessTokenWalletOrNull(undefined, resolver)).toBeNull();
    expect(getVerifiedAccessTokenWalletOrNull('Basic abc', resolver)).toBe(
      null
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns null when the secret cannot be resolved', () => {
    const token = sign({ sub: WALLET });

    expect(
      getVerifiedAccessTokenWalletOrNull(`Bearer ${token}`, () => {
        throw new Error('JWT_SECRET env var not found');
      })
    ).toBeNull();
  });

  it('never throws and never yields a wallet for arbitrary headers', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(
          getVerifiedAccessTokenWalletOrNull(`Bearer ${value}`, resolveSecret)
        ).toBeNull();
        expect(
          getVerifiedAccessTokenWalletOrNull(value, resolveSecret)
        ).toBeNull();
      })
    );
  });
});

describe('getAccessTokenClaimsOrNull', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;

  it('returns the claims of an access token payload', () => {
    expect(
      getAccessTokenClaimsOrNull({ id: 'id', sub: WALLET, role: 'r', exp })
    ).toEqual({ wallet: WALLET.toLowerCase(), role: 'r', exp });
    expect(getAccessTokenClaimsOrNull({ sub: WALLET, exp })).toEqual({
      wallet: WALLET.toLowerCase(),
      role: undefined,
      exp
    });
  });

  it.each([
    ['a string', 'signed message'],
    ['null', null],
    ['an array', [WALLET]],
    ['a non-wallet subject', { sub: 'not-a-wallet', exp }],
    ['a subject with a suffix', { sub: `${WALLET}0`, exp }],
    ['no expiry', { sub: WALLET }],
    ['a non-numeric expiry', { sub: WALLET, exp: String(exp) }],
    ['a non-string role', { sub: WALLET, role: 1, exp }],
    ['a challenge type', { sub: WALLET, exp, challenge_type: 'wallet_auth' }],
    ['an issuer', { sub: WALLET, exp, iss: 'issuer' }],
    ['an audience', { sub: WALLET, exp, aud: 'api.6529.io' }]
  ])('returns null for %s', (_, payload) => {
    expect(getAccessTokenClaimsOrNull(payload)).toBeNull();
  });

  it('never accepts a subject that is not a wallet address', () => {
    fc.assert(
      fc.property(
        fc.string().filter((sub) => !/^0x[0-9a-f]{40}$/i.test(sub)),
        fc.option(fc.string(), { nil: undefined }),
        (sub, role) => {
          expect(getAccessTokenClaimsOrNull({ sub, role, exp })).toBeNull();
        }
      )
    );
  });
});

describe('access token session claims', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const sessionId = '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e';

  it('returns the session claims of a current token', () => {
    expect(
      getAccessTokenClaimsOrNull({
        id: 'id',
        sub: WALLET,
        exp,
        ct: 'native',
        sb: 'share',
        sid: sessionId
      })
    ).toEqual({
      wallet: WALLET.toLowerCase(),
      role: undefined,
      exp,
      clientType: 'native',
      binding: 'share',
      sessionId
    });
  });

  it('keeps accepting a token minted before the session claims, unchanged', () => {
    const claims = getAccessTokenClaimsOrNull({ id: 'id', sub: WALLET, exp });
    expect(claims).toEqual({
      wallet: WALLET.toLowerCase(),
      role: undefined,
      exp
    });
    expect(
      Object.keys(claims ?? {}).sort((a, b) => a.localeCompare(b))
    ).toEqual(['exp', 'role', 'wallet']);
  });

  it('accepts a token whose session claims this build does not know', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.jsonValue(),
        fc.jsonValue(),
        (ct, sb, sid) => {
          expect(
            getAccessTokenClaimsOrNull({ sub: WALLET, exp, ct, sb, sid })
              ?.wallet
          ).toBe(WALLET.toLowerCase());
        }
      )
    );
  });

  it('verifies a signed token with and without session claims', () => {
    for (const payload of [
      { id: 'id', sub: WALLET },
      { id: 'id', sub: WALLET, ct: 'web', sb: 'siwe', sid: sessionId },
      { id: 'id', sub: WALLET, ct: 'legacy', sb: 'legacy_text' }
    ]) {
      expect(
        getVerifiedAccessTokenWalletOrNull(
          `Bearer ${sign(payload)}`,
          resolveSecret
        )
      ).toBe(WALLET.toLowerCase());
    }
  });
});
