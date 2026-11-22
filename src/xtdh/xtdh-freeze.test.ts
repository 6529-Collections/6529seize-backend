import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import {
  assertXTdhNotFrozen,
  isXTdhFrozen,
  XTDH_FROZEN_MESSAGE
} from './xtdh-freeze';

describe('xTDH freeze', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.FEATURE_IDENTITY_FROZEN;
    delete process.env.IDENTITY_FREEZE_AT;
  });

  afterAll(() => {
    process.env = env;
  });

  it('is off without the identity freeze', () => {
    expect(isXTdhFrozen()).toBe(false);
    expect(() => assertXTdhNotFrozen()).not.toThrow();
  });

  it('follows the identity freeze flag', () => {
    process.env.FEATURE_IDENTITY_FROZEN = 'true';
    expect(isXTdhFrozen()).toBe(true);
    try {
      assertXTdhNotFrozen();
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityFrozenException);
      expect((e as Error).message).toBe(XTDH_FROZEN_MESSAGE);
    }
  });

  it('starts at the identity freeze time', () => {
    process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
    expect(isXTdhFrozen(Date.UTC(2026, 10, 23, 23, 59))).toBe(false);
    expect(isXTdhFrozen(Date.UTC(2026, 10, 24, 0, 0))).toBe(true);
  });
});
