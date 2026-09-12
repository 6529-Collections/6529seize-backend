import fc from 'fast-check';
import { sumBadgeContributions } from './badge-count';

describe('sumBadgeContributions', () => {
  it.each([null, 'abc', '2oops', -1, NaN, Infinity, 1.5, undefined])(
    'rejects an invalid contribution: %s',
    (value) => {
      expect(() =>
        sumBadgeContributions([{ status: 'fulfilled', value }])
      ).toThrow('Invalid profile badge count');
    }
  );
  it('rejects partial refreshes instead of returning a falsely low count', () => {
    expect(() =>
      sumBadgeContributions([
        { status: 'fulfilled', value: 0 },
        { status: 'rejected', reason: new Error('unavailable') }
      ])
    ).toThrow('Unable to refresh all profile badge counts');
  });
  it('rejects overflow', () => {
    expect(() =>
      sumBadgeContributions([
        { status: 'fulfilled', value: Number.MAX_SAFE_INTEGER },
        { status: 'fulfilled', value: 1 }
      ])
    ).toThrow('overflow');
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
