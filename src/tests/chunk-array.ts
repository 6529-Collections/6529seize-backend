import fc from 'fast-check';
import { collections } from '../collections';

describe('collections.chunkArray', () => {
  it('chunks array into nearly equal batches', () => {
    expect(collections.chunkArray([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5]
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(collections.chunkArray([], 3)).toEqual([]);
  });

  it('size larger than length yields single chunk', () => {
    expect(collections.chunkArray([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('size 1 creates single item chunks', () => {
    expect(collections.chunkArray(['a', 'b', 'c'], 1)).toEqual([
      ['a'],
      ['b'],
      ['c']
    ]);
  });

  it('size equal to length results in one chunk', () => {
    expect(collections.chunkArray([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it('throws RangeError when size <= 0', () => {
    expect(() => collections.chunkArray([1, 2], 0)).toThrow(RangeError);
    expect(() => collections.chunkArray([1, 2], -1)).toThrow(RangeError);
  });

  it('floors non-integer size', () => {
    expect(collections.chunkArray([1, 2, 3, 4, 5], 2.7)).toEqual([
      [1, 2],
      [3, 4],
      [5]
    ]);
  });

  it('floors another fractional size', () => {
    expect(collections.chunkArray([1, 2, 3, 4], 3.9)).toEqual([[1, 2, 3], [4]]);
  });

  it('does not mutate original array', () => {
    const arr = [1, 2, 3];
    collections.chunkArray(arr, 2);
    expect(arr).toEqual([1, 2, 3]);
  });

  it('property: flatten equals original and chunk lengths are valid', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer()),
        fc.integer({ min: 1, max: 20 }),
        (arr, n) => {
          const out = collections.chunkArray(arr, n);

          expect(out.flat()).toEqual(arr);
          out.forEach((chunk) => expect(chunk.length).toBeGreaterThan(0));
          out.slice(0, -1).forEach((chunk) => expect(chunk.length).toBe(n));

          if (out.length > 0) {
            expect(out[out.length - 1].length).toBeLessThanOrEqual(n);
          }
        }
      )
    );
  });
});

describe.skip('performance', () => {
  it('handles 100k items quickly', () => {
    const arr = Array.from({ length: 100000 }, (_, i) => i);
    const start = Date.now();
    collections.chunkArray(arr, 1000);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
