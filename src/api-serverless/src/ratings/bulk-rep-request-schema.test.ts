jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

import * as fc from 'fast-check';
import { getValidatedByJoiOrThrow } from '../validation';
import { ApiBulkRepRequest } from '../generated/models/ApiBulkRepRequest';
import {
  BulkRepRequestSchema,
  MAX_BULK_REP_CATEGORIES,
  MAX_BULK_REP_TARGETS
} from './bulk-rep.routes';

function address(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

function validate(body: unknown): ApiBulkRepRequest {
  return getValidatedByJoiOrThrow(body, BulkRepRequestSchema);
}

describe('POST /bulk-rep request validation', () => {
  it(`accepts up to ${MAX_BULK_REP_TARGETS} targets`, () => {
    const targets = Array.from({ length: MAX_BULK_REP_TARGETS }, (_, i) => ({
      address: address(i),
      category: 'Art',
      amount: 1
    }));
    expect(validate({ targets }).targets).toHaveLength(MAX_BULK_REP_TARGETS);
  });

  it(`rejects more than ${MAX_BULK_REP_TARGETS} targets`, () => {
    const targets = Array.from(
      { length: MAX_BULK_REP_TARGETS + 1 },
      (_, i) => ({ address: address(i), category: 'Art', amount: 1 })
    );
    expect(() => validate({ targets })).toThrow(
      `"targets" must contain less than or equal to ${MAX_BULK_REP_TARGETS} items`
    );
  });

  it('caps the number of distinct categories', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_BULK_REP_CATEGORIES + 5 }),
        fc.integer({ min: 1, max: 3 }),
        (categories, repeats) => {
          const targets = Array.from(
            { length: categories * repeats },
            (_, i) => ({
              address: address(i),
              category: `Category ${i % categories}`,
              amount: 1
            })
          );
          if (categories <= MAX_BULK_REP_CATEGORIES) {
            expect(validate({ targets }).targets).toHaveLength(
              categories * repeats
            );
          } else {
            expect(() => validate({ targets })).toThrow(
              `"targets" can use at most ${MAX_BULK_REP_CATEGORIES} distinct categories`
            );
          }
        }
      )
    );
  });

  it('counts categories as they are stored, after trimming', () => {
    const targets = Array.from(
      { length: MAX_BULK_REP_CATEGORIES + 1 },
      (_, i) => ({
        address: address(i),
        category:
          i === MAX_BULK_REP_CATEGORIES ? ' Category 0 ' : `Category ${i}`,
        amount: 1
      })
    );
    const validated = validate({ targets });
    expect(validated.targets[MAX_BULK_REP_CATEGORIES].category).toBe(
      'Category 0'
    );
  });

  it('accepts the category cap when every category also repeats with surrounding whitespace', () => {
    const paddings = ['', ' ', '  ', '	'];
    const targets = Array.from(
      { length: MAX_BULK_REP_CATEGORIES * paddings.length },
      (_, i) => {
        const padding = paddings[Math.floor(i / MAX_BULK_REP_CATEGORIES)];
        return {
          address: address(i),
          category: `${padding}Category ${i % MAX_BULK_REP_CATEGORIES}${padding}`,
          amount: 1
        };
      }
    );

    const validated = validate({ targets });

    expect(
      new Set(validated.targets.map((target) => target.category)).size
    ).toBe(MAX_BULK_REP_CATEGORIES);
  });

  it('rejects one more distinct category past the cap even among padded duplicates', () => {
    const targets = [
      ...Array.from({ length: MAX_BULK_REP_CATEGORIES }, (_, i) => ({
        address: address(i),
        category: ` Category ${i} `,
        amount: 1
      })),
      ...Array.from({ length: MAX_BULK_REP_CATEGORIES }, (_, i) => ({
        address: address(MAX_BULK_REP_CATEGORIES + i),
        category: `Category ${i}`,
        amount: 1
      })),
      {
        address: address(2 * MAX_BULK_REP_CATEGORIES),
        category: ' Another category ',
        amount: 1
      }
    ];

    expect(() => validate({ targets })).toThrow(
      `"targets" can use at most ${MAX_BULK_REP_CATEGORIES} distinct categories`
    );
  });

  it.each([1.5, -0.25, 2_147_483_648, -2_147_483_648])(
    'rejects the amount %p',
    (amount) => {
      expect(() =>
        validate({
          targets: [{ address: address(1), category: 'Art', amount }]
        })
      ).toThrow(/amount/);
    }
  );

  it('accepts any integer amount a rating can hold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2_147_483_647, max: 2_147_483_647 }),
        (amount) => {
          expect(
            validate({
              targets: [{ address: address(1), category: 'Art', amount }]
            }).targets[0].amount
          ).toBe(amount);
        }
      )
    );
  });
});
