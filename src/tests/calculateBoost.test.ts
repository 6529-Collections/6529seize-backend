import { SZN1_INDEX, SZN2_INDEX, SZN3_INDEX, SZN4_INDEX } from '../constants';

const calculateBoost = require('../tdh').calculateBoost;

test('calculateBoost should calculate the boost correctly', () => {
  //s1 set
  expect(
    calculateBoost(0, SZN1_INDEX.count, 0, 0, 0, false, false, [], false)
  ).toBe(1.05);
  //s2 set
  expect(
    calculateBoost(0, 0, SZN2_INDEX.count, 0, 0, false, false, [], false)
  ).toBe(1.05);
  //s3 set
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, false, false, [], false)
  ).toBe(1.05);

  //s1 set + genesis
  expect(
    calculateBoost(0, SZN1_INDEX.count, 0, 0, 0, true, true, [], false)
  ).toBe(1.05);
  //s2 set + genesis
  expect(
    calculateBoost(0, 0, SZN2_INDEX.count, 0, 0, true, false, [], false)
  ).toBe(1.06);
  //s2 set + naka
  expect(
    calculateBoost(0, 0, SZN2_INDEX.count, 0, 0, false, true, [], false)
  ).toBe(1.06);
  //s2 set + genesis + naka
  expect(
    calculateBoost(0, 0, SZN2_INDEX.count, 0, 0, true, true, [], false)
  ).toBe(1.07);
  //s2 set + genesis + naka + 1gradient
  expect(
    calculateBoost(0, 0, SZN2_INDEX.count, 0, 0, true, true, [{ id: 1 }], false)
  ).toBe(1.09);
  //s2 set + genesis + naka + 2gradient
  expect(
    calculateBoost(
      0,
      0,
      SZN2_INDEX.count,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }],
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
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
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
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      false
    )
  ).toBe(1.13);

  //s3 set + genesis
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, true, false, [], false)
  ).toBe(1.06);
  //s3 set + naka
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, false, true, [], false)
  ).toBe(1.06);
  //s3 set + genesis + naka
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, true, true, [], false)
  ).toBe(1.07);
  //s3 set + genesis + ENS
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, true, true, [], true)
  ).toBe(1.09);
  //s3 set + genesis + 4gradient
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      false
    )
  ).toBe(1.13);

  //s3 set + genesis
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, true, false, [], false)
  ).toBe(1.06);
  //s3 set + naka
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, false, true, [], false)
  ).toBe(1.06);
  //s3 set + genesis + naka
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, true, true, [], false)
  ).toBe(1.07);
  //s3 set + genesis + ENS
  expect(
    calculateBoost(0, 0, 0, SZN3_INDEX.count, 0, true, true, [], true)
  ).toBe(1.09);
  //s3 set + genesis + 4gradient
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
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
      false,
      false,
      [],
      false
    )
  ).toBe(1.2);
  // 2set
  expect(
    calculateBoost(
      2,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      false,
      false,
      [],
      false
    )
  ).toBe(1.22);
  // 3set
  expect(
    calculateBoost(
      3,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      false,
      false,
      [],
      false
    )
  ).toBe(1.24);
  // 4set
  expect(
    calculateBoost(
      3,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      false,
      false,
      [],
      false
    )
  ).toBe(1.24);
  // 1set + ENS
  expect(
    calculateBoost(
      1,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      false,
      false,
      [],
      true
    )
  ).toBe(1.22);
  // 1set + 4gradient + ENS
  expect(
    calculateBoost(
      1,
      SZN1_INDEX.count,
      SZN2_INDEX.count,
      0,
      0,
      false,
      false,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      true
    )
  ).toBe(1.28);

  // 3set + 3gradient + ENS
  expect(
    calculateBoost(
      3,
      0,
      0,
      0,
      0,
      false,
      false,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      true
    )
  ).toBe(1.32);

  // 3set + naka + genesis + ENS
  expect(
    calculateBoost(
      3,
      0,
      0,
      0,
      0,
      true,
      true,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      true
    )
  ).toBe(1.32);

  //s4 set
  expect(
    calculateBoost(0, 0, 0, 0, SZN4_INDEX.count, false, false, [], false)
  ).toBe(1.05);

  //s3 + s4 set
  expect(
    calculateBoost(
      0,
      0,
      0,
      SZN3_INDEX.count,
      SZN4_INDEX.count,
      false,
      false,
      [],
      false
    )
  ).toBe(1.1);

  //s4 set + ens
  expect(
    calculateBoost(0, 0, 0, 0, SZN4_INDEX.count, false, false, [], true)
  ).toBe(1.07);
});
