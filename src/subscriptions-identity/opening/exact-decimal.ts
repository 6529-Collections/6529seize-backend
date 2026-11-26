/*
 * Exact sums of the doubles the subscription tables hold. Each double is
 * read as the decimal JavaScript prints for it (the shortest one that reads
 * back to the same double), scaled to 30 decimals as a bigint, so totals and
 * differences are exact and don't depend on the order they are added in.
 * A double with digits past the 30th decimal, such as a float residue like
 * 1.3877787807814457e-17, is rounded to 30 decimals the way Math.round
 * rounds: half toward positive infinity.
 */

const SCALE_DIGITS = 30;

/** 10^n (the target has no bigint exponent operator). */
function pow10(n: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < n; i++) {
    result *= BigInt(10);
  }
  return result;
}

const SCALE = pow10(SCALE_DIGITS);

/** `digits` without its last `drop` digits, rounded as Math.round rounds. */
function roundOff(digits: bigint, drop: number, negative: boolean): bigint {
  const unit = pow10(drop);
  const kept = digits / unit;
  const twice = (digits % unit) * BigInt(2);
  // Half goes toward positive infinity: up in size for a positive value,
  // down for a negative one.
  return twice > unit || (twice === unit && !negative)
    ? kept + BigInt(1)
    : kept;
}

/** A double as an exact scaled integer of its printed decimal. */
export function toScaled(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`Not a finite number: ${value}`);
  }
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Unexpected number text: ${text}`);
  }
  const [, sign, whole, fraction = '', exponentText] = match;
  const exponent = Number(exponentText ?? 0);
  const digits = `${whole}${fraction}`;
  // value = digits * 10^(exponent - fraction.length)
  const shift = SCALE_DIGITS + exponent - fraction.length;
  const scaled =
    shift >= 0
      ? BigInt(digits) * pow10(shift)
      : roundOff(BigInt(digits), -shift, sign === '-');
  return sign === '-' ? -scaled : scaled;
}

/** A scaled integer as a plain decimal, no trailing zeros. */
export function scaledToDecimal(scaled: bigint): string {
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE)
    .toString()
    .padStart(SCALE_DIGITS, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function exactSum(values: Iterable<number>): bigint {
  let total = BigInt(0);
  for (const value of Array.from(values)) {
    total += toScaled(value);
  }
  return total;
}

/** A plain decimal (as `scaledToDecimal` writes it) as a scaled integer. */
export function decimalToScaled(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Not a plain decimal: ${text}`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > SCALE_DIGITS) {
    throw new Error(`More than ${SCALE_DIGITS} decimals: ${text}`);
  }
  const scaled = BigInt(`${whole}${fraction.padEnd(SCALE_DIGITS, '0')}`);
  return sign === '-' ? -scaled : scaled;
}
