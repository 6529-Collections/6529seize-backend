import { calculateLevel, getLevelScoreBounds } from './profile-level';

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

  it('resolves when tdh is extremely large', () => {
    expect(calculateLevel({ tdh: 99999999999, rep: 0 })).toBe(100);
  });

  it('positive rep is added to TDH', () => {
    expect(calculateLevel({ tdh: 10000, rep: 50000 })).toBe(20);
  });

  it('negative rep is subtracted from TDH', () => {
    expect(calculateLevel({ tdh: 10000, rep: -9900 })).toBe(3);
  });

  it.each([
    {
      range: { min: 0, max: 0 },
      expected: {
        minInclusive: null,
        maxExclusive: 25,
        matchesNoScores: false
      }
    },
    {
      range: { min: 1, max: 1 },
      expected: {
        minInclusive: 25,
        maxExclusive: 50,
        matchesNoScores: false
      }
    },
    {
      range: { min: 100, max: 100 },
      expected: {
        minInclusive: 25_000_000,
        maxExclusive: null,
        matchesNoScores: false
      }
    },
    {
      range: { min: 0, max: 100 },
      expected: {
        minInclusive: null,
        maxExclusive: null,
        matchesNoScores: false
      }
    },
    {
      range: { min: -10, max: 0 },
      expected: {
        minInclusive: null,
        maxExclusive: 25,
        matchesNoScores: false
      }
    },
    {
      range: { min: null, max: -1 },
      expected: {
        minInclusive: null,
        maxExclusive: null,
        matchesNoScores: true
      }
    },
    {
      range: { min: 2, max: 1 },
      expected: {
        minInclusive: null,
        maxExclusive: null,
        matchesNoScores: true
      }
    }
  ])(
    'maps ordinal level range $range to score bounds',
    ({ range, expected }) => {
      expect(getLevelScoreBounds(range)).toEqual(expected);
    }
  );
});
