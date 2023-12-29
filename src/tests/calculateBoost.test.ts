import {
  SZN1_INDEX,
  SZN2_INDEX,
  SZN3_INDEX,
  SZN4_INDEX,
  SZN5_INDEX
} from '../constants';

const calculateBoost = require('../tdh').calculateBoost;

test('calculateBoost should calculate the boost correctly', () => {
  //s1 set
  expect(
    calculateBoost(
      0,
      SZN1_INDEX.count,
      0,
      0,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.05);
  //s2 set
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.05);
  //s3 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.05);
  //s4 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      SZN4_INDEX.count,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.05);
  //s5 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      0,
      SZN5_INDEX.count,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.05);

  //s1 set + genesis
  expect(
    calculateBoost(
      0,
      SZN1_INDEX.count,
      0,
      0,
      0,
      0,
      true,
      true,
      [],
      false,
      false
    )
  ).toBe(1.05);
  //s2 set + genesis
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      true,
      false,
      [],
      false,
      false
    )
  ).toBe(1.06);
  //s2 set + naka
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      true,
      [],
      false,
      false
    )
  ).toBe(1.06);
  //s2 set + genesis + naka
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      true,
      true,
      [],
      false,
      false
    )
  ).toBe(1.07);
  //s2 set + genesis + naka + 1gradient
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      true,
      true,
      [{ id: 1 }],
      false,
      false
    )
  ).toBe(1.09);
  //s2 set + genesis + naka + 2gradient
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }],
      false,
      false
    )
  ).toBe(1.11);
  //s2 set + genesis + naka + 3gradient
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      false,
      false
    )
  ).toBe(1.13);

  //s2 set + genesis + naka + 4gradient
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      false,
      false
    )
  ).toBe(1.13);

  //s3 set + genesis
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      true,
      false,
      [],
      false,
      false
    )
  ).toBe(1.06);
  //s3 set + naka
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      false,
      true,
      [],
      false,
      false
    )
  ).toBe(1.06);
  //s3 set + genesis + naka
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      true,
      true,
      [],
      false,
      false
    )
  ).toBe(1.07);
  //s3 set + genesis + ENS
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, 0, true, true, [], true, false)
  ).toBe(1.08);
  //s3 set + genesis + 4gradient
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      false,
      false
    )
  ).toBe(1.13);

  //s3 set + genesis
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      true,
      false,
      [],
      false,
      false
    )
  ).toBe(1.06);
  //s3 set + naka
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      false,
      true,
      [],
      false,
      false
    )
  ).toBe(1.06);
  //s3 set + genesis + naka
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      true,
      true,
      [],
      false,
      false
    )
  ).toBe(1.07);
  //s3 set + genesis + ENS
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, 0, true, true, [], true, false)
  ).toBe(1.08);
  //s3 set + genesis + 4gradient
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      false,
      false
    )
  ).toBe(1.13);

  // 1set
  expect(
    calculateBoost(
      1,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.25);
  // 2set
  expect(
    calculateBoost(
      2,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.27);
  // 3set
  expect(
    calculateBoost(
      3,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.29);
  // 4set
  expect(
    calculateBoost(
      3,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.29);
  // 1set + ENS
  expect(
    calculateBoost(
      1,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [],
      true,
      false
    )
  ).toBe(1.26);
  // 1set + 4gradient + ENS
  expect(
    calculateBoost(
      1,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      0,
      false,
      false,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      true,
      false
    )
  ).toBe(1.32);

  // 3set + 3gradient + ENS
  expect(
    calculateBoost(
      3,
      0,
      0,
      0,
      0,
      0,
      false,
      false,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      true,
      false
    )
  ).toBe(1.36);

  // 3set + naka + genesis + ENS
  expect(
    calculateBoost(
      3,
      0,
      0,
      0,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      true,
      false
    )
  ).toBe(1.36);

  //s4 set
  expect(
    calculateBoost(0, 0, 0, 0, SZN4_INDEX.count, 0, false, false, [], false)
  ).toBe(1.05);

  //s3 + s4 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      SZN4_INDEX.count,
      0,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.1);

  //s4 set + ens
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      SZN4_INDEX.count,
      0,
      false,
      false,
      [],
      true,
      false
    )
  ).toBe(1.06);

  //s5 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      0,
      SZN5_INDEX.count,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.05);

  //s4 + s5 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      SZN4_INDEX.count,
      SZN5_INDEX.count,
      false,
      false,
      [],
      false,
      false
    )
  ).toBe(1.1);

  //s5 set + ens
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      0,
      SZN5_INDEX.count,
      false,
      false,
      [],
      true,
      false
    )
  ).toBe(1.06);

  //s5 set + profile
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      0,
      SZN5_INDEX.count,
      false,
      false,
      [],
      false,
      true
    )
  ).toBe(1.08);

  //s5 set + ens + profile
  expect(
    calculateBoost(
      0,
      0,
      0,
      0,
      0,
      SZN5_INDEX.count,
      false,
      false,
      [],
      true,
      true
    )
  ).toBe(1.09);
});
