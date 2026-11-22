import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  calculateLevel,
  getLevelComponentsBorderByLevel,
  getLevelFromScore
} from './profile-level';

type GoldenLevels = {
  readonly borders: { readonly level: number; readonly score: string }[];
  readonly cases: {
    readonly score: string;
    readonly level: number;
    readonly why?: string;
  }[];
};

const golden: GoldenLevels = JSON.parse(
  readFileSync(path.join(__dirname, 'profile-level-golden.json'), 'utf8')
);

const LAST_SAFE_LEVEL = 602;
const LAST_SAFE_BORDER = 8885382734061690;

describe('Profile Level', () => {
  it('resolves when tdh is negative', () => {
    expect(calculateLevel({ tdh: -1, rep: 0 })).toBe(0);
  });

  it('resolves when tdh is 0', () => {
    expect(calculateLevel({ tdh: 0, rep: 0 })).toBe(0);
  });

  it('resolves when tdh is 24', () => {
    expect(calculateLevel({ tdh: 24, rep: 0 })).toBe(0);
  });

  it('resolves when tdh is 10000', () => {
    expect(calculateLevel({ tdh: 10000, rep: 0 })).toBe(11);
  });

  it('resolves when tdh is 25', () => {
    expect(calculateLevel({ tdh: 25, rep: 0 })).toBe(1);
  });

  it('keeps counting levels above 100', () => {
    expect(calculateLevel({ tdh: 25000000, rep: 0 })).toBe(100);
    expect(calculateLevel({ tdh: 25999999, rep: 0 })).toBe(100);
    expect(calculateLevel({ tdh: 26000000, rep: 0 })).toBe(101);
    expect(calculateLevel({ tdh: 99999999999, rep: 0 })).toBe(311);
  });

  it('positive rep is added to TDH', () => {
    expect(calculateLevel({ tdh: 10000, rep: 50000 })).toBe(20);
  });

  it('negative rep is subtracted from TDH', () => {
    expect(calculateLevel({ tdh: 10000, rep: -9900 })).toBe(3);
  });
});

describe('getLevelFromScore', () => {
  // JS numbers hold scores exactly only as safe integers (up to 2^53 - 1).
  const isSafe = (score: string) => Number.isSafeInteger(Number(score));
  const safeCases = golden.cases.filter((it) => isSafe(it.score));
  const unsafeCases = golden.cases.filter((it) => !isSafe(it.score));

  it('covers the golden cases', () => {
    // Every border to 300, one below each, and the named cases.
    expect(golden.cases).toHaveLength(610);
    expect(safeCases).toHaveLength(606);
  });

  it.each(safeCases.map((it) => [it.score, it.level] as const))(
    'score %s is level %d',
    (score, level) => {
      expect(getLevelFromScore(Number(score))).toBe(level);
    }
  );

  it('differs from the golden cases only past the safe integers', () => {
    // A score past 2^53 - 1 reads as level 602; a negative one as level 0.
    expect(
      unsafeCases.map((it) => ({
        score: it.score,
        golden: it.level,
        level: getLevelFromScore(Number(it.score))
      }))
    ).toEqual([
      { score: '9223372036854775807', golden: 779, level: LAST_SAFE_LEVEL },
      { score: '18446744073709551615', golden: 796, level: LAST_SAFE_LEVEL },
      {
        score: '170141183460469231731687303715884105727',
        golden: 1910,
        level: LAST_SAFE_LEVEL
      },
      {
        score: '-170141183460469231731687303715884105728',
        golden: 0,
        level: 0
      }
    ]);
  });

  it('reads every score from 2^53 - 1 up as level 602', () => {
    for (const score of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      1e20,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY
    ]) {
      expect(getLevelFromScore(score)).toBe(LAST_SAFE_LEVEL);
    }
    expect(getLevelFromScore(LAST_SAFE_BORDER)).toBe(LAST_SAFE_LEVEL);
    expect(getLevelFromScore(LAST_SAFE_BORDER - 1)).toBe(LAST_SAFE_LEVEL - 1);
  });

  it('reads NaN and negative infinity as level 0', () => {
    expect(getLevelFromScore(Number.NaN)).toBe(0);
    expect(getLevelFromScore(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('places a fractional score by its whole part', () => {
    expect(getLevelFromScore(25999999.5)).toBe(100);
    expect(getLevelFromScore(26000000.5)).toBe(101);
  });

  it('never goes down as the score goes up', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (score, step) => {
          const higher = Math.min(score + step, Number.MAX_SAFE_INTEGER);
          expect(getLevelFromScore(higher)).toBeGreaterThanOrEqual(
            getLevelFromScore(score)
          );
        }
      )
    );
  });
});

describe('getLevelComponentsBorderByLevel', () => {
  it('has the golden borders for levels 0 to 300', () => {
    expect(golden.borders).toHaveLength(301);
  });

  it.each(golden.borders.map((it) => [it.level, it.score] as const))(
    'level %d starts at %s',
    (level, score) => {
      expect(getLevelComponentsBorderByLevel(level)).toBe(Number(score));
    }
  );

  it('ends at level 602, the last border that is a safe integer', () => {
    expect(getLevelComponentsBorderByLevel(LAST_SAFE_LEVEL)).toBe(
      LAST_SAFE_BORDER
    );
    expect(getLevelComponentsBorderByLevel(LAST_SAFE_LEVEL + 1)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(getLevelComponentsBorderByLevel(100000)).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('returns negative levels unchanged', () => {
    expect(getLevelComponentsBorderByLevel(-1)).toBe(-1);
    expect(getLevelComponentsBorderByLevel(-100)).toBe(-100);
  });

  it('is the inverse of getLevelFromScore at every border', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: LAST_SAFE_LEVEL }), (level) => {
        const border = getLevelComponentsBorderByLevel(level);
        expect(getLevelFromScore(border)).toBe(level);
        expect(getLevelFromScore(border - 1)).toBe(level - 1);
      })
    );
  });
});
