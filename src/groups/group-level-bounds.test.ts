import fc from 'fast-check';
import { toRuleNeutralLevelBounds } from './group-level-bounds';

type Bounds = { level_min: number | null; level_max: number | null };

const inBounds = ({ level_min, level_max }: Bounds, level: number) =>
  (level_min === null || level >= level_min) &&
  (level_max === null || level <= level_max);

const bound = fc.option(fc.integer({ min: -150, max: 700 }), { nil: null });
const bounds = fc.record({ level_min: bound, level_max: bound });

describe('toRuleNeutralLevelBounds', () => {
  it.each([
    [
      { level_min: null, level_max: 100 },
      { level_min: 0, level_max: null }
    ],
    [
      { level_min: 50, level_max: 100 },
      { level_min: 50, level_max: null }
    ],
    [
      { level_min: -5, level_max: 150 },
      { level_min: -5, level_max: null }
    ],
    [
      { level_min: 101, level_max: null },
      { level_min: 101, level_max: -1 }
    ],
    [
      { level_min: 150, level_max: 200 },
      { level_min: 150, level_max: -1 }
    ],
    [
      { level_min: 150, level_max: 50 },
      { level_min: 150, level_max: 50 }
    ],
    [
      { level_min: 100, level_max: 99 },
      { level_min: 100, level_max: 99 }
    ],
    [
      { level_min: null, level_max: null },
      { level_min: null, level_max: null }
    ],
    [
      { level_min: 0, level_max: null },
      { level_min: 0, level_max: null }
    ]
  ])('stores %j as %j', (input, expected) => {
    expect(toRuleNeutralLevelBounds(input)).toEqual(expected);
  });

  it('keeps a level criterion exactly when there was one', () => {
    fc.assert(
      fc.property(bounds, (input) => {
        const output = toRuleNeutralLevelBounds(input);
        expect(output.level_min !== null || output.level_max !== null).toBe(
          input.level_min !== null || input.level_max !== null
        );
      })
    );
  });

  it('admits the same levels while levels end at 100', () => {
    fc.assert(
      fc.property(bounds, fc.integer({ min: 0, max: 100 }), (input, level) => {
        expect(inBounds(toRuleNeutralLevelBounds(input), level)).toBe(
          inBounds(input, level)
        );
      })
    );
  });

  it('admits under uncapped levels what the bounds admitted when levels ended at 100', () => {
    fc.assert(
      fc.property(bounds, fc.integer({ min: 0, max: 700 }), (input, level) => {
        expect(inBounds(toRuleNeutralLevelBounds(input), level)).toBe(
          inBounds(input, Math.min(level, 100))
        );
      })
    );
  });

  it('changes nothing the second time', () => {
    fc.assert(
      fc.property(bounds, (input) => {
        const once = toRuleNeutralLevelBounds(input);
        expect(toRuleNeutralLevelBounds(once)).toEqual(once);
      })
    );
  });
});
