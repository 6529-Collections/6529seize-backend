import fc from 'fast-check';
import { assignRanksByValue } from './nft-extended-data';

type Item = { id: number; value: number; rank?: number };

/**
 * The pre-optimization O(n^2) implementation, kept verbatim as a reference:
 * rank = 1 + count of items strictly better by (value per direction, id asc).
 */
function referenceAssignRanks(
  arr: Item[],
  direction: 'asc' | 'desc'
): Map<number, number> {
  const ranks = new Map<number, number>();
  arr.forEach((item) => {
    const itemValue = item.value;
    const rank =
      arr.filter((other) => {
        const otherValue = other.value;
        if (direction === 'asc') {
          return (
            otherValue < itemValue ||
            (otherValue === itemValue && other.id < item.id)
          );
        } else {
          return (
            otherValue > itemValue ||
            (otherValue === itemValue && other.id < item.id)
          );
        }
      }).length + 1;
    ranks.set(item.id, rank);
  });
  return ranks;
}

const itemsArb: fc.Arbitrary<Item[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 1000 }), { maxLength: 40 })
  .chain((ids) =>
    fc.tuple(
      fc.constant(ids),
      fc.array(fc.integer({ min: -5, max: 5 }), {
        minLength: ids.length,
        maxLength: ids.length
      })
    )
  )
  .map(([ids, values]) =>
    ids.map((id, i) => ({ id, value: values[i] }) as Item)
  );

describe('assignRanksByValue', () => {
  it('assigns exactly the ranks of the pre-optimization counting implementation', () => {
    fc.assert(
      fc.property(
        itemsArb,
        fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
        (items, direction) => {
          const expected = referenceAssignRanks(items, direction);

          const actual = items.map((i) => ({ ...i }));
          assignRanksByValue(actual, 'rank', (i) => i.value, direction);

          actual.forEach((item) => {
            expect(item.rank).toBe(expected.get(item.id));
          });
        }
      ),
      { numRuns: 200 }
    );
  });

  it('gives duplicate values distinct ranks broken by ascending id', () => {
    const items: Item[] = [
      { id: 3, value: 10 },
      { id: 1, value: 10 },
      { id: 2, value: 7 }
    ];
    assignRanksByValue(items, 'rank', (i) => i.value, 'desc');
    const rankById = new Map(items.map((i) => [i.id, i.rank]));
    expect(rankById.get(1)).toBe(1);
    expect(rankById.get(3)).toBe(2);
    expect(rankById.get(2)).toBe(3);
  });
});
