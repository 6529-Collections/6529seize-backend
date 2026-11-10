import fc from 'fast-check';
import { optionalQueryDigits, optionalQueryString } from '@/api/query-values';
import { BadRequestException } from '@/exceptions';

describe('optionalQueryString', () => {
  it('returns a single string value unchanged', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(optionalQueryString({ contract: value }, 'contract')).toBe(
          value
        );
      })
    );
  });

  it('returns undefined for an absent parameter or query', () => {
    expect(optionalQueryString({}, 'contract')).toBeUndefined();
    expect(optionalQueryString(undefined, 'contract')).toBeUndefined();
  });

  it.each([
    ['a repeated parameter', ['a', 'b']],
    ['a nested parameter', { contract: '1' }],
    ['a number', 5]
  ])('rejects %s with a 400', (_label, value) => {
    expect(() => optionalQueryString({ contract: value }, 'contract')).toThrow(
      BadRequestException
    );
  });
});

describe('optionalQueryDigits', () => {
  it('accepts digits, an empty value or an absent parameter', () => {
    expect(optionalQueryDigits({ block: '18000000' }, 'block')).toBe(
      '18000000'
    );
    expect(optionalQueryDigits({ block: '' }, 'block')).toBe('');
    expect(optionalQueryDigits({}, 'block')).toBeUndefined();
  });

  it.each(['-1', '1.5', '1e5', 'abc', ' 1'])('rejects %p', (value) => {
    expect(() => optionalQueryDigits({ block: value }, 'block')).toThrow(
      BadRequestException
    );
  });
});
