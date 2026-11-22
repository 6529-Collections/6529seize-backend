import {
  assertIdentityNotFrozen,
  IDENTITY_FROZEN_CODE,
  IDENTITY_FROZEN_MESSAGE,
  IDENTITY_FROZEN_NOMINATION_MESSAGE,
  IdentityFrozenException,
  isIdentityFrozen
} from '@/identity-freeze/identity-freeze';
import { apiCompliantErrorBody } from '@/exceptions';

const FLAG = 'FEATURE_IDENTITY_FROZEN';

describe('identity freeze flag', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it.each([
    [undefined, false],
    ['true', true],
    ['false', false],
    ['TRUE', false],
    ['1', false],
    ['', false]
  ])('reads FEATURE_IDENTITY_FROZEN=%s as %s', (value, frozen) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    expect(isIdentityFrozen()).toBe(frozen);
    if (frozen) {
      expect(() => assertIdentityNotFrozen()).toThrow(IdentityFrozenException);
    } else {
      expect(() => assertIdentityNotFrozen()).not.toThrow();
    }
  });

  it('answers 423 with the freeze code and a plain message', () => {
    process.env[FLAG] = 'true';
    let thrown: unknown;
    try {
      assertIdentityNotFrozen();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IdentityFrozenException);
    const error = thrown as IdentityFrozenException;
    expect(error.getStatusCode()).toBe(423);
    expect(apiCompliantErrorBody(error)).toEqual({
      error: IDENTITY_FROZEN_MESSAGE,
      code: IDENTITY_FROZEN_CODE
    });
  });

  it('carries a site-specific message when given one', () => {
    process.env[FLAG] = 'true';
    expect(() =>
      assertIdentityNotFrozen(IDENTITY_FROZEN_NOMINATION_MESSAGE)
    ).toThrow(IDENTITY_FROZEN_NOMINATION_MESSAGE);
  });
});
