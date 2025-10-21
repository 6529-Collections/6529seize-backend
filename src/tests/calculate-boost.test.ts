import { MemesSeason } from '../entities/ISeason';
import { TokenTDH } from '../entities/ITDH';

import { calculateBoost } from '../tdhLoop/tdh';

const seasons: MemesSeason[] = [
  {
    id: 1,
    start_index: 1,
    end_index: 47,
    count: 47,
    name: 'SZN1',
    display: 'SZN1'
  },
  {
    id: 2,
    start_index: 48,
    end_index: 86,
    count: 39,
    name: 'SZN2',
    display: 'SZN2'
  },
  {
    id: 3,
    start_index: 87,
    end_index: 118,
    count: 32,
    name: 'SZN3',
    display: 'SZN3'
  },
  {
    id: 4,
    start_index: 119,
    end_index: 151,
    count: 33,
    name: 'SZN4',
    display: 'SZN4'
  },
  {
    id: 5,
    start_index: 152,
    end_index: 180,
    count: 29,
    name: 'SZN5',
    display: 'SZN5'
  },
  {
    id: 6,
    start_index: 181,
    end_index: 212,
    count: 32,
    name: 'SZN6',
    display: 'SZN6'
  },
  {
    id: 7,
    start_index: 213,
    end_index: 245,
    count: 33,
    name: 'SZN7',
    display: 'SZN7'
  },
  {
    id: 8,
    start_index: 246,
    end_index: 278,
    count: 33,
    name: 'SZN8',
    display: 'SZN8'
  },
  {
    id: 9,
    start_index: 279,
    end_index: 310,
    count: 32,
    name: 'SZN9',
    display: 'SZN9'
  },
  {
    id: 10,
    start_index: 311,
    end_index: 342,
    count: 32,
    name: 'SZN10',
    display: 'SZN10'
  },
  {
    id: 11,
    start_index: 343,
    end_index: 374,
    count: 32,
    name: 'SZN11',
    display: 'SZN11'
  },
  {
    id: 12,
    start_index: 375,
    end_index: 406,
    count: 32,
    name: 'SZN12',
    display: 'SZN12'
  }
];

describe('calculateBoost', () => {
  describe('single season set baseline (no genesis/naka, no gradients)', () => {
    const cases: Array<{
      seasonId: number;
      expected: number;
      extras?: Partial<{ genesis: number; nakamoto: number }>;
    }> = [
      { seasonId: 1, expected: 1.05 },
      { seasonId: 2, expected: 1.05 },
      { seasonId: 3, expected: 1.05 },
      { seasonId: 4, expected: 1.05 },
      { seasonId: 5, expected: 1.05 },
      { seasonId: 6, expected: 1.05 },
      { seasonId: 7, expected: 1.05 },
      // s8 special cases are covered below; still verify base without genesis
      { seasonId: 8, expected: 1.05 },
      { seasonId: 9, expected: 1.05 },
      { seasonId: 10, expected: 1.05 },
      { seasonId: 11, expected: 1.05 },
      { seasonId: 12, expected: 1.05 }
    ];

    test.each(cases)('S%p baseline = %p', ({ seasonId, expected }) => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 0 },
        getSeasonSet(seasonId),
        []
      );
      expect(result.total).toBe(expected);
    });
  });

  describe('genesis / nakamoto / gradients modifiers', () => {
    it('S8 set with genesis should be 1.06', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 1, nakamoto: 0 },
        getSeasonSet(8),
        []
      );
      expect(result.total).toBe(1.06);
    });

    it('S8 set (explicitly no genesis/naka) should be 1.05', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 0 },
        getSeasonSet(8),
        []
      );
      expect(result.total).toBe(1.05);
    });

    it('S2 set + genesis = 1.06', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 1, nakamoto: 0 },
        getSeasonSet(2),
        []
      );
      expect(result.total).toBe(1.06);
    });

    it('S2 set + nakamoto = 1.06', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 1 },
        getSeasonSet(2),
        []
      );
      expect(result.total).toBe(1.06);
    });

    it('S2 set + genesis + nakamoto = 1.07', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 1, nakamoto: 1 },
        getSeasonSet(2),
        []
      );
      expect(result.total).toBe(1.07);
    });

    it('S2 set + genesis + nakamoto + gradients(1..6 cap at 5)', () => {
      expect(
        calculateBoost(
          seasons,
          0,
          { genesis: 1, nakamoto: 1 },
          getSeasonSet(2),
          [{ id: 1 }]
        ).total
      ).toBe(1.09);
      expect(
        calculateBoost(
          seasons,
          0,
          { genesis: 1, nakamoto: 1 },
          getSeasonSet(2),
          [{ id: 1 }, { id: 2 }]
        ).total
      ).toBe(1.11);
      expect(
        calculateBoost(
          seasons,
          0,
          { genesis: 1, nakamoto: 1 },
          getSeasonSet(2),
          [{ id: 1 }, { id: 2 }, { id: 3 }]
        ).total
      ).toBe(1.13);
      expect(
        calculateBoost(
          seasons,
          0,
          { genesis: 1, nakamoto: 1 },
          getSeasonSet(2),
          [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
        ).total
      ).toBe(1.15);
      expect(
        calculateBoost(
          seasons,
          0,
          { genesis: 1, nakamoto: 1 },
          getSeasonSet(2),
          [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
        ).total
      ).toBe(1.17);
      // 6th gradient should be capped
      expect(
        calculateBoost(
          seasons,
          0,
          { genesis: 1, nakamoto: 1 },
          getSeasonSet(2),
          [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]
        ).total
      ).toBe(1.17);
    });

    it('S3 set + genesis = 1.06', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 1, nakamoto: 0 },
        getSeasonSet(3),
        []
      );
      expect(result.total).toBe(1.06);
    });

    it('S3 set + nakamoto = 1.06', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 1 },
        getSeasonSet(3),
        []
      );
      expect(result.total).toBe(1.06);
    });

    it('S3 set + genesis + nakamoto = 1.07', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 1, nakamoto: 1 },
        getSeasonSet(3),
        []
      );
      expect(result.total).toBe(1.07);
    });
  });

  describe('multiple complete sets modifier', () => {
    const cases = [
      { sets: 1, expected: 1.6 },
      { sets: 2, expected: 1.65 },
      { sets: 3, expected: 1.68 },
      { sets: 4, expected: 1.7 },
      { sets: 5, expected: 1.72 },
      { sets: 10, expected: 1.74 }
    ];

    test.each(cases)('%p complete set(s) (S3) => %p', ({ sets, expected }) => {
      const result = calculateBoost(
        seasons,
        sets,
        { genesis: 1, nakamoto: 0 },
        getSeasonSet(3),
        []
      );
      expect(result.total).toBe(expected);
    });

    it('1 set + 4 gradients on S3 => 1.68', () => {
      const result = calculateBoost(
        seasons,
        1,
        { genesis: 1, nakamoto: 0 },
        getSeasonSet(3),
        [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
      );
      expect(result.total).toBe(1.68);
    });

    it('3 sets + 3 gradients on S3 => 1.74', () => {
      const result = calculateBoost(
        seasons,
        3,
        { genesis: 1, nakamoto: 0 },
        getSeasonSet(3),
        [{ id: 1 }, { id: 2 }, { id: 3 }]
      );
      expect(result.total).toBe(1.74);
    });

    it('3 sets + genesis + nakamoto + 3 gradients on S3 => 1.74', () => {
      const result = calculateBoost(
        seasons,
        3,
        { genesis: 1, nakamoto: 1 },
        getSeasonSet(3),
        [{ id: 1 }, { id: 2 }, { id: 3 }]
      );
      expect(result.total).toBe(1.74);
    });
  });

  describe('two-season combos', () => {
    it('S3 + S4 set => 1.1', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 0 },
        [...getSeasonSet(3), ...getSeasonSet(4)],
        []
      );
      expect(result.total).toBe(1.1);
    });

    it('S4 + S5 set => 1.1', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 0 },
        [...getSeasonSet(4), ...getSeasonSet(5)],
        []
      );
      expect(result.total).toBe(1.1);
    });
  });
});

function getSeasonSet(id: number): TokenTDH[] {
  const s = seasons.find((s) => s.id === id);

  if (!s) {
    return [];
  }

  const tokens: TokenTDH[] = [];
  for (let i = s.start_index; i <= s.end_index; i++) {
    tokens.push({
      id: i,
      balance: 1,
      tdh: 1,
      tdh__raw: 1,
      hodl_rate: 1,
      days_held_per_edition: [1]
    });
  }
  return tokens;
}
