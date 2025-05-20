import { areEqualAddresses } from '../helpers';

describe('areEqualAddresses', () => {
  it('returns true for identical addresses regardless of case', () => {
    expect(areEqualAddresses('0xAbCd', '0xaBcD')).toBe(true);
  });

  it('returns false for different addresses', () => {
    expect(areEqualAddresses('0xabc', '0xdef')).toBe(false);
  });

  it('returns false when a value is missing', () => {
    expect(areEqualAddresses('', '0xdef')).toBe(false);
    expect(areEqualAddresses('0xabc', undefined as any)).toBe(false);
    expect(areEqualAddresses(null as any, '0xabc')).toBe(false);
  });
});
