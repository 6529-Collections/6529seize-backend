import * as fc from 'fast-check';
import {
  ceilingDivide,
  exactEthToWei,
  weiToExactEth,
  WEI_PER_ETH
} from './subscription-coverage-money';

const ZERO = BigInt(0);
const ONE = BigInt(1);

describe('subscription coverage exact money', () => {
  it('converts the production mint price without floating-point arithmetic', () => {
    expect(exactEthToWei('0.06529')).toBe(BigInt('65290000000000000'));
  });

  it('round-trips arbitrary whole-wei values through exact ETH strings', () => {
    fc.assert(
      fc.property(
        fc.bigInt({
          min: -BigInt('1000000000000000000000000000000'),
          max: BigInt('1000000000000000000000000000000')
        }),
        (wei) => {
          expect(exactEthToWei(weiToExactEth(wei))).toBe(wei);
        }
      )
    );
  });

  it('rejects fractions smaller than one wei', () => {
    expect(() => exactEthToWei('0.0000000000000000001')).toThrow(
      'more than 18 fractional digits'
    );
  });

  it('formats whole and fractional ETH without insignificant zeroes', () => {
    expect(weiToExactEth(BigInt(2) * WEI_PER_ETH)).toBe('2');
    expect(weiToExactEth(-BigInt('1500000000000000000'))).toBe('-1.5');
  });

  it('performs exact positive ceiling division', () => {
    expect(ceilingDivide(ZERO, BigInt(7))).toBe(ZERO);
    expect(ceilingDivide(BigInt(7), BigInt(7))).toBe(ONE);
    expect(ceilingDivide(BigInt(8), BigInt(7))).toBe(BigInt(2));
    expect(() => ceilingDivide(-ONE, BigInt(7))).toThrow();
    expect(() => ceilingDivide(ONE, ZERO)).toThrow();
  });
});
