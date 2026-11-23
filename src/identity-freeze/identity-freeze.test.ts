import {
  assertIdentityNotFrozen,
  IDENTITY_FROZEN_CODE,
  IDENTITY_FROZEN_MESSAGE,
  IDENTITY_FROZEN_NOMINATION_MESSAGE,
  IdentityFrozenException,
  isIdentityFrozen,
  parseIdentityFreezeAt
} from '@/identity-freeze/identity-freeze';
import { apiCompliantErrorBody } from '@/exceptions';

const FLAG = 'FEATURE_IDENTITY_FROZEN';
const AT = 'IDENTITY_FREEZE_AT';
const T = Date.UTC(2026, 10, 24, 0, 0, 0);

describe('identity freeze flag', () => {
  const original = process.env[FLAG];
  const originalAt = process.env[AT];
  beforeEach(() => {
    delete process.env[AT];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
    if (originalAt === undefined) delete process.env[AT];
    else process.env[AT] = originalAt;
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

  it.each([
    ['2026-11-24T00:00:00Z', T],
    ['2026-11-24T00:00Z', T],
    ['2026-11-24T00:00:00.000Z', T],
    ['2026-11-24T00:00:00+00:00', T],
    [String(T), T],
    ['  2026-11-24T00:00:00Z  ', T]
  ])('reads IDENTITY_FREEZE_AT=%s as a UTC time', (raw, expected) => {
    expect(parseIdentityFreezeAt(raw)).toBe(expected);
  });

  it.each([
    '2026-11-24 00:00',
    '2026-11-24T00:00:00',
    '2026-11-24T01:00:00+01:00',
    'tomorrow',
    '2026-13-40T00:00:00Z'
  ])('reads IDENTITY_FREEZE_AT=%s as no UTC time', (raw) => {
    expect(parseIdentityFreezeAt(raw)).toBeNull();
  });

  it.each([undefined, '', '   '])(
    'reads an unset IDENTITY_FREEZE_AT (%s) as no freeze time',
    (raw) => {
      expect(parseIdentityFreezeAt(raw)).toBeUndefined();
    }
  );

  it('freezes from IDENTITY_FREEZE_AT on, without the flag', () => {
    delete process.env[FLAG];
    process.env[AT] = '2026-11-24T00:00:00Z';
    expect(isIdentityFrozen(T - 1)).toBe(false);
    expect(isIdentityFrozen(T)).toBe(true);
    expect(isIdentityFrozen(T + 60_000)).toBe(true);
  });

  it('freezes on a malformed IDENTITY_FREEZE_AT', () => {
    delete process.env[FLAG];
    process.env[AT] = '24 Nov 2026';
    expect(isIdentityFrozen(0)).toBe(true);
  });

  it('the flag freezes before IDENTITY_FREEZE_AT too', () => {
    process.env[FLAG] = 'true';
    process.env[AT] = '2026-11-24T00:00:00Z';
    expect(isIdentityFrozen(T - 1)).toBe(true);
  });
});
