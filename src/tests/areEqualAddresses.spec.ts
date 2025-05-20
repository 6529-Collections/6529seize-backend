import { areEqualAddresses } from '../helpers';
import fc from 'fast-check';

describe('areEqualAddresses', () => {
  it.each([
    ['0xabc', '0xABC', true],
    ['0x123', '0x124', false],
    ['', '0xabc', false],
    ['0xabc', '', false],
    [undefined as any, '0xabc', false],
    ['0xabc', undefined as any, false],
    [null as any, '0xabc', false],
    ['0xabc', null as any, false]
  ])('areEqualAddresses(%p, %p) -> %p', (a, b, expected) => {
    expect(areEqualAddresses(a as any, b as any)).toBe(expected);
  });

  it('ignores case when comparing', () => {
    fc.assert(
      fc.property(fc.hexaString({ minLength: 40, maxLength: 40 }), (hex) => {
        const lower = '0x' + hex.toLowerCase();
        const upper = '0x' + hex.toUpperCase();
        expect(areEqualAddresses(lower, upper)).toBe(true);
      })
    );
  });

  it('is symmetric for all strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(areEqualAddresses(a as any, b as any)).toBe(
          areEqualAddresses(b as any, a as any)
        );
      })
    );
  });
});
