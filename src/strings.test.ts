import fc from 'fast-check';
import { hasLoneSurrogate, sliceWholeCodePoints } from './strings';

describe('sliceWholeCodePoints', () => {
  it('never cuts an emoji in half', () => {
    expect(sliceWholeCodePoints('notes 😀', 7)).toBe('notes ');
    expect(sliceWholeCodePoints('notes 😀', 8)).toBe('notes 😀');
    expect(sliceWholeCodePoints('notes', 3)).toBe('not');
    expect(sliceWholeCodePoints('notes', 0)).toBe('');
  });

  it('keeps whole code points and stays within the length', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), fc.nat(40), (text, length) => {
        const cut = sliceWholeCodePoints(text, length);
        expect(cut.length).toBeLessThanOrEqual(length);
        expect(text.startsWith(cut)).toBe(true);
        expect(hasLoneSurrogate(cut)).toBe(false);
        // At most the one unit of a split pair is given up.
        expect(cut.length).toBeGreaterThanOrEqual(
          Math.min(text.length, length) - 1
        );
      })
    );
  });
});

describe('hasLoneSurrogate', () => {
  it.each([
    ['plain text', 'gm', false],
    ['a pair', '😀', false],
    ['a cut emoji', '😀'.slice(0, 1), true],
    ['a lone low half', '😀'.slice(1), true],
    ['reversed halves', '😀'.slice(1) + '😀'.slice(0, 1), true]
  ])('%s', (_name, text, lone) => {
    expect(hasLoneSurrogate(text)).toBe(lone);
  });
});
