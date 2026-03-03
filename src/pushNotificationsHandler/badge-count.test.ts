import fc from 'fast-check';
import { sumBadgeContributions } from './badge-count';

describe('sumBadgeContributions', () => {
  it('sums fulfilled numeric values and ignores invalid/rejected values', () => {
    const contributions: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: '2' },
      { status: 'fulfilled', value: 3 },
      { status: 'fulfilled', value: 'abc' },
      { status: 'fulfilled', value: null },
      { status: 'rejected', reason: new Error('boom') }
    ];

    expect(sumBadgeContributions(contributions)).toBe(5);
  });

  it('returns the numeric sum for integer values represented as numbers or strings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000 }), { maxLength: 50 }),
        fc.array(fc.boolean(), { maxLength: 50 }),
        (values, asStringFlags) => {
          const contributions: PromiseSettledResult<unknown>[] = values.map(
            (value, index) => ({
              status: 'fulfilled',
              value: asStringFlags[index] ? value.toString() : value
            })
          );
          const expected = values.reduce((sum, value) => sum + value, 0);

          expect(sumBadgeContributions(contributions)).toBe(expected);
        }
      )
    );
  });
});
