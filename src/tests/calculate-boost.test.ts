import { MemesSeason } from '../entities/ISeason';
import { TokenTDH } from '../entities/ITDH';
import { Time } from '../time';

const calculateBoost = require('../tdhLoop/tdh').calculateBoost;

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
  }
];

test('calculateBoost should calculate the boost correctly', () => {
  //s1 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(1),
      []
    ).total
  ).toBe(1.05);

  //s2 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(2),
      []
    ).total
  ).toBe(1.05);

  // s3 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.05);

  // s4 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(4),
      []
    ).total
  ).toBe(1.05);

  // s5 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(5),
      []
    ).total
  ).toBe(1.05);

  // s6 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(6),
      []
    ).total
  ).toBe(1.05);

  // s7 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(7),
      []
    ).total
  ).toBe(1.05);

  // s8 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(8),
      []
    ).total
  ).toBe(1.06);

  // s8 set + genesis
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(8),
      []
    ).total
  ).toBe(1.05);

  // s9 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(9),
      []
    ).total
  ).toBe(1.05);

  // s10 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(10),
      []
    ).total
  ).toBe(1.05);

  // s11 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      getSeasonSet(11),
      []
    ).total
  ).toBe(1.05);

  // s1 set + genesis
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(1),
      []
    ).total
  ).toBe(1.05);

  // s2 set + genesis
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(2),
      []
    ).total
  ).toBe(1.06);

  // s2 set + naka
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 1
      },
      getSeasonSet(2),
      []
    ).total
  ).toBe(1.06);

  // s2 set + genesis + naka
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(2),
      []
    ).total
  ).toBe(1.07);

  // s2 set + genesis + naka + 1gradient
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(2),
      [{ id: 1 }]
    ).total
  ).toBe(1.09);

  // s2 set + genesis + naka + 2gradient
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(2),
      [{ id: 1 }, { id: 2 }]
    ).total
  ).toBe(1.11);

  // s2 set + genesis + naka + 3gradient
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(2),
      [{ id: 1 }, { id: 2 }, { id: 3 }]
    ).total
  ).toBe(1.13);

  // s2 set + genesis + naka + 4gradient
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(2),
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    ).total
  ).toBe(1.13);

  // s3 set + genesis
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.06);

  // s3 set + naka
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 1
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.06);

  // s3 set + genesis + naka
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.07);

  // 1set
  expect(
    calculateBoost(
      seasons,
      1,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.55);

  // 2set
  expect(
    calculateBoost(
      seasons,
      2,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.57);

  // 3set
  expect(
    calculateBoost(
      seasons,
      3,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.59);

  // 4set
  expect(
    calculateBoost(
      seasons,
      4,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      []
    ).total
  ).toBe(1.59);

  // 1set + 4gradient
  expect(
    calculateBoost(
      seasons,
      1,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    ).total
  ).toBe(1.61);

  // 3set + 3gradient
  expect(
    calculateBoost(
      seasons,
      3,
      {
        genesis: 1,
        nakamoto: 0
      },
      getSeasonSet(3),
      [{ id: 1 }, { id: 2 }, { id: 3 }]
    ).total
  ).toBe(1.65);

  // 3set + naka + genesis + 3gradient
  expect(
    calculateBoost(
      seasons,
      3,
      {
        genesis: 1,
        nakamoto: 1
      },
      getSeasonSet(3),
      [{ id: 1 }, { id: 2 }, { id: 3 }]
    ).total
  ).toBe(1.65);

  // s3 + s4 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      [...getSeasonSet(3), ...getSeasonSet(4)],
      []
    ).total
  ).toBe(1.1);

  // s4 + s5 set
  expect(
    calculateBoost(
      seasons,
      0,
      {
        genesis: 0,
        nakamoto: 0
      },
      [...getSeasonSet(4), ...getSeasonSet(5)],
      []
    ).total
  ).toBe(1.1);
});

function getSeasonSet(id: number): TokenTDH[] {
  const s = seasons.find((s) => s.id === id);

  if (!s) {
    return [];
  }

  const tokens: TokenTDH[] = [];
  for (let i = s.start_index; i <= s.end_index; i++) {
    tokens.push({ id: i, balance: 1, tdh: 1, tdh__raw: 1, hodl_rate: 1 });
  }
  return tokens;
}
