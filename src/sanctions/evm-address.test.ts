import * as fc from 'fast-check';
import {
  extractEvmAddresses,
  normalizeEvmAddress,
  tickerBefore
} from '@/sanctions/evm-address';
import { readSanctionsVector } from '@/sanctions/sanctions-spec-files';

interface AddressVectors {
  normalize: Array<{ input: string; output: string | null }>;
  extract: Array<{ text: string; addresses: string[] }>;
}

const vectors = readSanctionsVector<AddressVectors>(
  'address-normalization.json'
);

const hex40 = fc
  .array(fc.constantFrom(...'0123456789abcdefABCDEF'.split('')), {
    minLength: 40,
    maxLength: 40
  })
  .map((chars) => `0x${chars.join('')}`);

describe('normalizeEvmAddress', () => {
  it.each(vectors.normalize)('normalizes %j', ({ input, output }) => {
    expect(normalizeEvmAddress(input)).toBe(output);
  });

  it.each([undefined, null, 42, {}, ['0x']])(
    'rejects non-strings (%p)',
    (value) => {
      expect(normalizeEvmAddress(value)).toBeNull();
    }
  );

  it('lowercases every well-formed address and is idempotent', () => {
    fc.assert(
      fc.property(hex40, (address) => {
        const normalized = normalizeEvmAddress(address);
        expect(normalized).toBe(address.toLowerCase());
        expect(normalizeEvmAddress(normalized)).toBe(normalized);
      })
    );
  });
});

describe('extractEvmAddresses', () => {
  it.each(vectors.extract)('extracts from %j', ({ text, addresses }) => {
    expect(extractEvmAddresses(text).map((match) => match.address)).toEqual(
      addresses
    );
  });

  it('reports where each raw address starts', () => {
    const text = 'x ETH: 0xAbCdEf0123456789aBcDeF0123456789AbCdEf01;';
    const [match] = extractEvmAddresses(text);
    expect(text.slice(match.index, match.index + 42)).toBe(match.raw);
  });

  it('finds any address separated by non-alphanumeric text', () => {
    fc.assert(
      fc.property(
        hex40,
        fc.constantFrom(' ', ';', ':', '\n', '：', ', '),
        (address, separator) => {
          const found = extractEvmAddresses(
            `a${separator}${address}${separator}`
          );
          expect(found.map((match) => match.address)).toEqual([
            address.toLowerCase()
          ]);
        }
      )
    );
  });
});

describe('tickerBefore', () => {
  it.each([
    ['ETH: ', 'ETH'],
    ['(7) BNB: ', 'BNB'],
    ['Digital Currency Address - ETH ', 'ETH'],
    ['Digital Currency Address: ETH ', 'ETH'],
    ['Ethereum crypto addresses:   ', null],
    ['暗号資産アドレス：', null],
    ['0x1111111111111111111111111111111111111111 ', null]
  ])('reads %j as %p', (prefix, expected) => {
    expect(tickerBefore(`${prefix}0x`, prefix.length)).toBe(expected);
  });
});
