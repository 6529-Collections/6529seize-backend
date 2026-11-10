jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException } from '@/exceptions';
import { RedeemRefreshTokenRequestSchema } from './auth.routes';

function validate(body: unknown) {
  return getValidatedByJoiOrThrow(body, RedeemRefreshTokenRequestSchema);
}

const token = randomBytes(64).toString('hex');
const address = '0x33fd426905f149f8376e227d0c9d3340aad17af1';

describe('redeem refresh token request validation', () => {
  it('passes a valid request through unchanged', () => {
    const body = { token, address, role: 'some-profile-id' };
    expect(validate(body)).toEqual(body);
    expect(validate({ token })).toEqual({ token });
    expect(validate({ token, address: null, role: null })).toEqual({
      token,
      address: null,
      role: null
    });
  });

  it('accepts any issued token shape', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (bytes) => {
        const issued = Buffer.from(bytes).toString('hex');
        expect(validate({ token: issued }).token).toBe(issued);
      })
    );
  });

  it.each([{}, { token: '' }, { address }])(
    'keeps the missing-token message for %p',
    (body) => {
      expect(() => validate(body)).toThrow('Refresh token is required');
    }
  );

  it.each([
    undefined,
    { token: { $ne: '' } },
    { token: [token] },
    { token: 12345 },
    { token: 'not-hex' },
    { token: 'a'.repeat(257) },
    { token, address: 'not-an-address' },
    { token, address: { a: 1 } },
    { token, role: { a: 1 } },
    { token, role: ['r'] }
  ])('rejects %p', (body) => {
    expect(() => validate(body)).toThrow(BadRequestException);
  });
});
