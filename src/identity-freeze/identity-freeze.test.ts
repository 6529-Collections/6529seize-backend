import { Logger } from '@/logging';
import {
  assertIdentityNotFrozen,
  IDENTITY_FROZEN_CODE,
  IDENTITY_FROZEN_MESSAGE,
  IDENTITY_FROZEN_NOMINATION_MESSAGE,
  IDENTITY_ON_CHAIN_MESSAGE,
  IDENTITY_ON_CHAIN_NOMINATION_MESSAGE,
  IdentityFrozenException,
  identityRefusalMessage,
  isIdentityOnChain,
  isIdentityFrozen,
  parseIdentityFreezeAt
} from '@/identity-freeze/identity-freeze';
import { apiCompliantErrorBody } from '@/exceptions';

const FLAG = 'FEATURE_IDENTITY_FROZEN';
const AT = 'IDENTITY_FREEZE_AT';
const ON_CHAIN = 'FEATURE_IDENTITY_ON_CHAIN';
const SWITCH_ON_AT = 'IDENTITY_SWITCH_ON_AT';
const C = Date.UTC(2026, 10, 25, 0, 0, 0);
const T = Date.UTC(2026, 10, 24, 0, 0, 0);

describe('identity freeze flag', () => {
  const original = process.env[FLAG];
  const saved = [AT, ON_CHAIN, SWITCH_ON_AT].map(
    (name) => [name, process.env[name]] as const
  );
  beforeEach(() => {
    delete process.env[AT];
    delete process.env[ON_CHAIN];
    delete process.env[SWITCH_ON_AT];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

  it('with every identity setting unset, nothing is frozen or on the chain, before or after the dates', () => {
    delete process.env[FLAG];
    for (const now of [T - 1, T, C, C + 86_400_000]) {
      expect(isIdentityFrozen(now)).toBe(false);
      expect(isIdentityOnChain(now)).toBe(false);
    }
    expect(() => assertIdentityNotFrozen()).not.toThrow();
    expect(() => assertIdentityNotFrozen('nomination')).not.toThrow();
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
    expect(() => assertIdentityNotFrozen('nomination')).toThrow(
      IDENTITY_FROZEN_NOMINATION_MESSAGE
    );
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
    '2026-13-40T00:00:00Z',
    '1795564800',
    '20261125',
    '0'
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

  it('stays refused from switch-on, whatever the freeze settings', () => {
    delete process.env[FLAG];
    process.env[SWITCH_ON_AT] = '2026-11-25T00:00:00Z';
    expect(isIdentityOnChain(C - 1)).toBe(false);
    expect(isIdentityFrozen(C - 1)).toBe(false);
    expect(isIdentityOnChain(C)).toBe(true);
    expect(isIdentityFrozen(C)).toBe(true);
    expect(identityRefusalMessage('write', C)).toBe(IDENTITY_ON_CHAIN_MESSAGE);
    expect(identityRefusalMessage('nomination', C)).toBe(
      IDENTITY_ON_CHAIN_NOMINATION_MESSAGE
    );
    expect(identityRefusalMessage('write', C - 1)).toBe(
      IDENTITY_FROZEN_MESSAGE
    );
  });

  it('says where to make the change once the flag says it is on the chain', () => {
    process.env[ON_CHAIN] = 'true';
    expect(isIdentityFrozen()).toBe(true);
    expect(() => assertIdentityNotFrozen()).toThrow(IDENTITY_ON_CHAIN_MESSAGE);
    expect(() => assertIdentityNotFrozen('nomination')).toThrow(
      IDENTITY_ON_CHAIN_NOMINATION_MESSAGE
    );
    expect(apiCompliantErrorBody(new IdentityFrozenException())).toEqual({
      error: IDENTITY_ON_CHAIN_MESSAGE,
      code: IDENTITY_FROZEN_CODE
    });
  });

  it('does not switch on at a switch-on time before 24 Nov 2026, freeze time or not', () => {
    process.env[SWITCH_ON_AT] = '1764028800000';
    expect(isIdentityOnChain(Date.UTC(2026, 10, 23))).toBe(false);
    expect(isIdentityFrozen(Date.UTC(2026, 10, 23))).toBe(true);
    process.env[SWITCH_ON_AT] = '2026-11-25T00:00:00Z';
    expect(isIdentityOnChain(Date.UTC(2026, 10, 25))).toBe(true);
  });

  it('does not switch on at a switch-on time before the freeze time, but freezes', () => {
    process.env[AT] = '2026-11-24T00:00:00Z';
    process.env[SWITCH_ON_AT] = '2025-11-25T00:00:00Z';
    expect(isIdentityOnChain(Date.UTC(2026, 10, 23))).toBe(false);
    expect(isIdentityFrozen(Date.UTC(2026, 10, 23))).toBe(true);
    process.env[SWITCH_ON_AT] = '2026-11-25T00:00:00Z';
    expect(isIdentityOnChain(Date.UTC(2026, 10, 25))).toBe(true);
  });

  it.each(['2026-11-31T00:00:00Z', '2026-02-30T00:00:00Z'])(
    'reads a date that does not exist (%s) as no time',
    (raw) => {
      expect(parseIdentityFreezeAt(raw)).toBeNull();
    }
  );

  it.each([
    ['Wednesday', 'IS NOT A UTC TIME'],
    ['2025-11-25T00:00:07Z', 'IS BEFORE 2026-11-24T00:00:00Z'],
    ['1795564800', 'IS NOT A UTC TIME']
  ])('logs once why a switch-on time of %s is refused', (value, reason) => {
    const error = jest.spyOn(Logger.prototype, 'error');
    try {
      process.env[SWITCH_ON_AT] = value;
      expect(isIdentityOnChain(Date.UTC(2026, 10, 26))).toBe(false);
      expect(isIdentityFrozen(Date.UTC(2026, 10, 26))).toBe(true);
      isIdentityOnChain(Date.UTC(2026, 10, 26));
      const lines = error.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes(value));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(reason);
    } finally {
      error.mockRestore();
    }
  });

  it('switches on from the first second of 24 Nov 2026, not before', () => {
    process.env[SWITCH_ON_AT] = '2026-11-23T23:59:59Z';
    expect(isIdentityOnChain(Date.UTC(2026, 10, 25))).toBe(false);
    process.env[SWITCH_ON_AT] = '2026-11-24T00:00:00Z';
    expect(isIdentityOnChain(Date.UTC(2026, 10, 25))).toBe(true);
  });

  it('freezes on a malformed switch-on time, but does not switch on', () => {
    for (const value of ['Wednesday', '2026-11-25', '1795564800', '0']) {
      process.env[SWITCH_ON_AT] = value;
      expect(isIdentityOnChain(Date.UTC(2026, 11, 1))).toBe(false);
      expect(isIdentityFrozen(0)).toBe(true);
    }
  });
});
