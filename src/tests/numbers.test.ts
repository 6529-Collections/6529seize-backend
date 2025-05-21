import fc from 'fast-check';
import { numbers } from '../numbers';

describe('numbers.parseIntOrNull', () => {
  const cases: Array<[unknown, number | null]> = [
    ['10', 10],
    [' -7 ', -7],
    ['+3', 3],
    ['10.5', null],
    ['0xFF', null],
    ['0b10', null],
    [undefined, null],
    [null, null],
    ['', null],
    [42, 42],
    [NaN, null],
    [Infinity, null],
    ['\t8\n', 8],
    ['\u00a010', 10]
  ];

  it.each(cases)('numbers.parseIntOrNull(%p) => %p', (input, expected) => {
    expect(numbers.parseIntOrNull(input)).toBe(expected);
  });

  it('round-trips any integer string', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(numbers.parseIntOrNull(n.toString())).toBe(n);
      })
    );
  });

  it('rejects any float string', () => {
    fc.assert(
      fc.property(
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((d) => !Number.isInteger(d)),
        (d) => {
          expect(numbers.parseIntOrNull(d.toString())).toBeNull();
        }
      )
    );
  });
});
