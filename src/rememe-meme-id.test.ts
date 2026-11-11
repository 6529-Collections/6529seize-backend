import fc from 'fast-check';
import {
  canonicalRememeMemeId,
  MAX_REMEME_MEME_ID_DIGITS
} from './rememe-meme-id';

describe('canonicalRememeMemeId', () => {
  it.each([
    ['7', '7'],
    ['007', '7'],
    ['0', '0'],
    ['000', '0'],
    ['100', '100']
  ])('normalises %p to %p', (input, expected) => {
    expect(canonicalRememeMemeId(input)).toBe(expected);
  });

  it('always yields a value that parses as the same JSON number', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat({ max: 10 }), (id, zeros) => {
        const canonical = canonicalRememeMemeId('0'.repeat(zeros) + id);
        expect(canonical).toBe(String(id));
        expect(JSON.parse(canonical!)).toBe(id);
      })
    );
  });

  it.each(['', '-1', '1.5', '1e3', ' 1', 'a', '1'.repeat(16)])(
    'rejects %p',
    (input) => {
      expect(canonicalRememeMemeId(input)).toBeNull();
    }
  );

  it('accepts the longest allowed id, also behind leading zeros', () => {
    const longest = '9'.repeat(MAX_REMEME_MEME_ID_DIGITS);
    expect(canonicalRememeMemeId(longest)).toBe(longest);
    expect(canonicalRememeMemeId('0000' + longest)).toBe(longest);
  });
});
