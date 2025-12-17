import { MemesSeason } from '../entities/ISeason';
import { TokenTDH } from '../entities/ITDH';

import { calculateBoost } from '../tdhLoop/tdh';

const seasonData = [
  { start_index: 1, end_index: 47, count: 47 },
  { start_index: 48, end_index: 86, count: 39 },
  { start_index: 87, end_index: 118, count: 32 },
  { start_index: 119, end_index: 151, count: 33 },
  { start_index: 152, end_index: 180, count: 29 },
  { start_index: 181, end_index: 212, count: 32 },
  { start_index: 213, end_index: 245, count: 33 },
  { start_index: 246, end_index: 278, count: 33 },
  { start_index: 279, end_index: 310, count: 32 },
  { start_index: 311, end_index: 342, count: 32 },
  { start_index: 343, end_index: 374, count: 32 },
  { start_index: 375, end_index: 406, count: 32 }
];

const seasons: MemesSeason[] = seasonData.map((data, index) => ({
  id: index + 1,
  ...data,
  name: `SZN${index + 1}`,
  display: `SZN${index + 1}`,
  boost: 0.05
}));

function getSeasonSet(id: number): TokenTDH[] {
  const season = seasons.find((s) => s.id === id);
  if (!season) return [];

  return Array.from({ length: season.count }, (_, i) => ({
    id: season.start_index + i,
    balance: 1,
    tdh: 1,
    tdh__raw: 1,
    hodl_rate: 1,
    days_held_per_edition: [1]
  }));
}

function createGradients(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
}

describe('calculateBoost', () => {
  describe('baseline season sets', () => {
    test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
      'S%p baseline = 1.05',
      (seasonId) => {
        const result = calculateBoost(
          seasons,
          0,
          { genesis: 0, nakamoto: 0 },
          getSeasonSet(seasonId),
          []
        );
        expect(result.total).toBe(1.05);
      }
    );

    it('S12 (max season) has no boost = 1.0', () => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 0 },
        getSeasonSet(12),
        []
      );
      expect(result.total).toBe(1.0);
    });
  });

  describe('genesis and nakamoto modifiers', () => {
    const genesisNakamotoCases = [
      {
        seasonId: 2,
        genesis: 1,
        nakamoto: 0,
        expected: 1.06,
        desc: 'S2 + genesis'
      },
      {
        seasonId: 2,
        genesis: 0,
        nakamoto: 1,
        expected: 1.06,
        desc: 'S2 + nakamoto'
      },
      {
        seasonId: 2,
        genesis: 1,
        nakamoto: 1,
        expected: 1.07,
        desc: 'S2 + genesis + nakamoto'
      },
      {
        seasonId: 3,
        genesis: 1,
        nakamoto: 0,
        expected: 1.06,
        desc: 'S3 + genesis'
      },
      {
        seasonId: 3,
        genesis: 0,
        nakamoto: 1,
        expected: 1.06,
        desc: 'S3 + nakamoto'
      },
      {
        seasonId: 3,
        genesis: 1,
        nakamoto: 1,
        expected: 1.07,
        desc: 'S3 + genesis + nakamoto'
      },
      {
        seasonId: 8,
        genesis: 1,
        nakamoto: 0,
        expected: 1.06,
        desc: 'S8 + genesis'
      }
    ];

    test.each(genesisNakamotoCases)(
      '$desc = $expected',
      ({ seasonId, genesis, nakamoto, expected }) => {
        const result = calculateBoost(
          seasons,
          0,
          { genesis, nakamoto },
          getSeasonSet(seasonId),
          []
        );
        expect(result.total).toBe(expected);
      }
    );
  });

  describe('gradient modifiers', () => {
    const gradientCases = [
      {
        count: 1,
        expected: 1.09,
        desc: 'S2 + genesis + nakamoto + 1 gradient'
      },
      {
        count: 2,
        expected: 1.11,
        desc: 'S2 + genesis + nakamoto + 2 gradients'
      },
      {
        count: 3,
        expected: 1.13,
        desc: 'S2 + genesis + nakamoto + 3 gradients'
      },
      {
        count: 4,
        expected: 1.15,
        desc: 'S2 + genesis + nakamoto + 4 gradients'
      },
      {
        count: 5,
        expected: 1.17,
        desc: 'S2 + genesis + nakamoto + 5 gradients'
      },
      {
        count: 6,
        expected: 1.17,
        desc: 'S2 + genesis + nakamoto + 6 gradients (capped at 5)'
      }
    ];

    test.each(gradientCases)('$desc = $expected', ({ count, expected }) => {
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 1, nakamoto: 1 },
        getSeasonSet(2),
        createGradients(count)
      );
      expect(result.total).toBe(expected);
    });
  });

  describe('multiple complete sets', () => {
    const cardSetCases = [
      { sets: 1, expected: 1.6 },
      { sets: 2, expected: 1.65 },
      { sets: 3, expected: 1.68 },
      { sets: 4, expected: 1.7 },
      { sets: 5, expected: 1.72 },
      { sets: 10, expected: 1.74 }
    ];

    test.each(cardSetCases)(
      '$sets set(s) on S3 = $expected',
      ({ sets, expected }) => {
        const result = calculateBoost(
          seasons,
          sets,
          { genesis: 1, nakamoto: 0 },
          getSeasonSet(3),
          []
        );
        expect(result.total).toBe(expected);
      }
    );

    const combinedCases = [
      {
        sets: 1,
        gradients: 4,
        expected: 1.68,
        desc: '1 set + 4 gradients on S3'
      },
      {
        sets: 3,
        gradients: 3,
        expected: 1.74,
        desc: '3 sets + 3 gradients on S3'
      },
      {
        sets: 3,
        gradients: 3,
        genesis: 1,
        nakamoto: 1,
        expected: 1.74,
        desc: '3 sets + genesis + nakamoto + 3 gradients on S3'
      }
    ];

    test.each(combinedCases)(
      '$desc = $expected',
      ({ sets, gradients, genesis = 1, nakamoto = 0, expected }) => {
        const result = calculateBoost(
          seasons,
          sets,
          { genesis, nakamoto },
          getSeasonSet(3),
          createGradients(gradients)
        );
        expect(result.total).toBe(expected);
      }
    );
  });

  describe('multiple season sets', () => {
    test.each([
      { seasons: [3, 4], expected: 1.1 },
      { seasons: [4, 5], expected: 1.1 }
    ])('S$seasons = $expected', ({ seasons: seasonIds, expected }) => {
      const tokens = seasonIds.flatMap((id) => getSeasonSet(id));
      const result = calculateBoost(
        seasons,
        0,
        { genesis: 0, nakamoto: 0 },
        tokens,
        []
      );
      expect(result.total).toBe(expected);
    });
  });
});
