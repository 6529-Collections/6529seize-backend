import * as fc from 'fast-check';
import * as jwt from 'jsonwebtoken';
import {
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
    ['a numeric subject', { sub: 123 }]
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
