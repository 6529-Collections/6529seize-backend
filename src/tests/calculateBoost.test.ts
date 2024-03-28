import { MemesSeason } from '../entities/ISeason';
import { TokenTDH } from '../entities/ITDH';

const calculateBoost = require('../tdhLoop/tdh').calculateBoost;

const seasons: MemesSeason[] = [
  {
    id: 1,
    start_index: 1,
    end_index: 47,
    count: 47,
    name: 'SNZ1',
    display: 'SNZ1'
  },
  {
    id: 2,
    start_index: 48,
    end_index: 86,
    count: 39,
    name: 'SNZ2',
    display: 'SNZ2'
  },
  {
    id: 3,
    start_index: 87,
    end_index: 118,
    count: 32,
    name: 'SNZ3',
    display: 'SNZ3'
  },
  {
    id: 4,
    start_index: 119,
    end_index: 151,
    count: 33,
    name: 'SNZ4',
    display: 'SNZ4'
  },
  {
    id: 5,
    start_index: 152,
    end_index: 180,
    count: 29,
    name: 'SNZ5',
    display: 'SNZ5'
  },
  {
    id: 6,
    start_index: 181,
    end_index: 212,
    count: 32,
    name: 'SNZ6',
    display: 'SNZ6'
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
  ).toBe(1.3);

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
  ).toBe(1.32);

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
  ).toBe(1.34);

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
  ).toBe(1.34);

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
  ).toBe(1.36);

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
  ).toBe(1.4);

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
  ).toBe(1.4);

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
    tokens.push({ id: i, balance: 1, tdh: 1, tdh__raw: 1 });
  }
  return tokens;
}
