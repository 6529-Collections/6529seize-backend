import fc from 'fast-check';
import { isRatingOutOfBounds } from './user-group-predicates';

/**
 * Property tests for the bounds primitive every eligibility window check
 * reduces to (docs/eligibility-spec.md §1.2).
 */
describe('isRatingOutOfBounds properties', () => {
  const intArb = fc.integer({ min: -1_000_000, max: 1_000_000 });
  const nullableIntArb = fc.option(intArb, { nil: null });

  it('with both bounds null, the result depends only on the non-zero-required modifier', () => {
    fc.assert(
      fc.property(intArb, fc.boolean(), (real, nonZeroRequired) => {
        const outOfBounds = isRatingOutOfBounds({
          min: null,
          max: null,
          real,
          minMaxNullMeansNonZeroRequired: nonZeroRequired
        });
        expect(outOfBounds).toBe(nonZeroRequired && real === 0);
      })
    );
  });

  it('with at least one bound set, it is exact inclusive interval membership and the modifier is irrelevant', () => {
    fc.assert(
      fc.property(
        nullableIntArb,
        nullableIntArb,
        intArb,
        fc.boolean(),
        (min, max, real, nonZeroRequired) => {
          fc.pre(min !== null || max !== null);
          const outOfBounds = isRatingOutOfBounds({
            min,
            max,
            real,
            minMaxNullMeansNonZeroRequired: nonZeroRequired
          });
          const inInterval =
            (min === null || real >= min) && (max === null || real <= max);
          expect(outOfBounds).toBe(!inInterval);
          expect(outOfBounds).toBe(
            isRatingOutOfBounds({
              min,
              max,
              real,
              minMaxNullMeansNonZeroRequired: !nonZeroRequired
            })
          );
        }
      )
    );
  });

  it('bounds are inclusive on both ends', () => {
    fc.assert(
      fc.property(intArb, (bound) => {
        expect(
          isRatingOutOfBounds({
            min: bound,
            max: bound,
            real: bound,
            minMaxNullMeansNonZeroRequired: true
          })
        ).toBe(false);
      })
    );
  });

  it('widening a satisfied window never makes the value out of bounds', () => {
    fc.assert(
      fc.property(
        intArb,
        intArb,
        intArb,
        fc.nat({ max: 1000 }),
        fc.boolean(),
        (min, max, real, widenBy, nonZeroRequired) => {
          fc.pre(
            !isRatingOutOfBounds({
              min,
              max,
              real,
              minMaxNullMeansNonZeroRequired: nonZeroRequired
            })
          );
          expect(
            isRatingOutOfBounds({
              min: min - widenBy,
              max: max + widenBy,
              real,
              minMaxNullMeansNonZeroRequired: nonZeroRequired
            })
          ).toBe(false);
        }
      )
    );
  });
});
