import {
  decimalToScaled,
  exactSum,
  scaledToDecimal,
  toScaled
} from './exact-decimal';

describe('exact decimals of doubles', () => {
  it('reads each double as the decimal JavaScript prints for it', () => {
    expect(scaledToDecimal(toScaled(0.06529))).toBe('0.06529');
    expect(scaledToDecimal(toScaled(1e-7))).toBe('0.0000001');
    expect(scaledToDecimal(toScaled(-2.5))).toBe('-2.5');
    expect(scaledToDecimal(toScaled(27 * 0.06529))).toBe(String(27 * 0.06529));
    expect(scaledToDecimal(toScaled(1e21))).toBe('1000000000000000000000');
  });

  it('sums exactly, in any order', () => {
    const values = [0.1, 0.2, 0.06529, 1.76283, 0.00001];
    const sum = exactSum(values);
    expect(scaledToDecimal(sum)).toBe('2.12813');
    expect(exactSum([...values].reverse())).toBe(sum);
    // A double sum drifts; the exact one does not.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(scaledToDecimal(exactSum([0.1, 0.2]))).toBe('0.3');
  });

  it('reads back what it writes', () => {
    for (const text of ['0', '1', '-0.00000123', '123.456789012345678901']) {
      expect(scaledToDecimal(decimalToScaled(text))).toBe(text);
    }
    expect(() => decimalToScaled('1e5')).toThrow('Not a plain decimal');
  });

  it('refuses a value that is not a finite number', () => {
    expect(() => toScaled(Number.NaN)).toThrow('Not a finite number');
    expect(() => toScaled(Number.POSITIVE_INFINITY)).toThrow(
      'Not a finite number'
    );
  });

  it('rounds digits past the 30th decimal, as Math.round does', () => {
    // A float residue: 0.1 + 0.2 - 0.3 and its kind.
    const residue = 1.3877787807814457e-17;
    expect(scaledToDecimal(toScaled(residue))).toBe(
      '0.000000000000000013877787807814'
    );
    expect(scaledToDecimal(toScaled(-residue))).toBe(
      '-0.000000000000000013877787807814'
    );
    expect(scaledToDecimal(toScaled(0.1 + 0.2 - 0.3))).toBe(
      '0.000000000000000055511151231258'
    );
    expect(scaledToDecimal(exactSum([0.5, residue]))).toBe(
      '0.500000000000000013877787807814'
    );
    // Below half of the 30th decimal rounds to 0; half rounds toward
    // positive infinity, up for a positive value and down for a negative
    // one.
    expect(scaledToDecimal(toScaled(1e-31))).toBe('0');
    expect(scaledToDecimal(toScaled(5e-31))).toBe(
      '0.000000000000000000000000000001'
    );
    expect(scaledToDecimal(toScaled(-5e-31))).toBe('0');
    expect(scaledToDecimal(toScaled(-6e-31))).toBe(
      '-0.000000000000000000000000000001'
    );
  });
});
