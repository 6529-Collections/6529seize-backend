export const WEI_PER_ETH = BigInt('1000000000000000000');

const EXACT_ETH_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);

/**
 * Parses a base-10 ETH amount without passing through a JavaScript number.
 * More than 18 fractional digits cannot be represented as whole wei.
 */
export function exactEthToWei(value: string): bigint {
  const normalized = value.trim();
  const match = EXACT_ETH_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`Invalid exact ETH amount: ${value}`);
  }

  const [, sign, integerPart, fractionalPart = ''] = match;
  if (fractionalPart.length > 18) {
    throw new Error(`ETH amount has more than 18 fractional digits: ${value}`);
  }

  const fractionWei = BigInt(fractionalPart.padEnd(18, '0') || '0');
  const unsignedWei = BigInt(integerPart) * WEI_PER_ETH + fractionWei;
  return sign === '-' ? -unsignedWei : unsignedWei;
}

/**
 * Formats wei as a lossless base-10 ETH string and removes insignificant
 * fractional zeroes.
 */
export function weiToExactEth(value: bigint): string {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const integerPart = absolute / WEI_PER_ETH;
  const fractionalPart = absolute % WEI_PER_ETH;
  const sign = negative ? '-' : '';

  if (fractionalPart === ZERO) {
    return `${sign}${integerPart}`;
  }

  const fraction = fractionalPart
    .toString()
    .padStart(18, '0')
    .replace(/0+$/, '');
  return `${sign}${integerPart}.${fraction}`;
}

export function ceilingDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator < ZERO) {
    throw new Error('Ceiling division numerator must be non-negative');
  }
  if (denominator <= ZERO) {
    throw new Error('Ceiling division denominator must be positive');
  }
  if (numerator === ZERO) {
    return ZERO;
  }
  return (numerator + denominator - ONE) / denominator;
}
