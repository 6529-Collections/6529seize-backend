import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import {
  assertXTdhNotRetired,
  isXTdhRetired,
  XTDH_RETIRED_MESSAGE
} from './xtdh-retired';

describe('xTDH retirement', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.FEATURE_IDENTITY_FROZEN;
    delete process.env.IDENTITY_FREEZE_AT;
  });

  afterAll(() => {
    process.env = env;
  });

  it('is off while identities are on 6529.io', () => {
    expect(isXTdhRetired()).toBe(false);
    expect(() => assertXTdhNotRetired()).not.toThrow();
  });

  it('follows the identity freeze flag', () => {
    process.env.FEATURE_IDENTITY_FROZEN = 'true';
    expect(isXTdhRetired()).toBe(true);
    try {
      assertXTdhNotRetired();
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityFrozenException);
      expect((e as Error).message).toBe(XTDH_RETIRED_MESSAGE);
    }
  });

  it('starts at the identity freeze time', () => {
    process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
    expect(isXTdhRetired(Date.UTC(2026, 10, 23, 23, 59))).toBe(false);
    expect(isXTdhRetired(Date.UTC(2026, 10, 24, 0, 0))).toBe(true);
  });
});
