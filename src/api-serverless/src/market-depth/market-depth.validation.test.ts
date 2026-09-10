import {
  decodeMarketCursor,
  encodeMarketCursor,
  validateActivityQuery,
  validateDepthPath,
  validateDepthQuery
} from './market-depth.validation';

const contract = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';

describe('market API validation', () => {
  it('normalizes contracts while preserving large token IDs as strings', () => {
    expect(
      validateDepthPath({ contract, token_id: '9007199254740993' })
    ).toEqual({
      contract: contract.toLowerCase(),
      token_id: '9007199254740993'
    });
  });

  it.each(['-1', '1.5', '01', '1e3', '9'.repeat(79)])(
    'rejects malformed token ID %s',
    (token_id) => {
      expect(() => validateDepthPath({ contract, token_id })).toThrow();
    }
  );

  it('bounds page size and cursor size and rejects unknown activity filters', () => {
    expect(validateDepthQuery({})).toEqual({ page_size: 50 });
    expect(validateDepthQuery({ page_size: '100' }).page_size).toBe(100);
    for (const page_size of [0, 101, 1.5]) {
      expect(() => validateDepthQuery({ page_size })).toThrow();
    }
    expect(() => validateDepthQuery({ cursor: 'a'.repeat(2049) })).toThrow();
    expect(() => validateActivityQuery({ filter: 'expiration' })).toThrow();
    expect(validateActivityQuery({ filter: 'expirations' }).filter).toBe(
      'expirations'
    );
  });

  it('requires exactly one collection for token-scoped activity', () => {
    expect(() => validateActivityQuery({ token_id: '8' })).toThrow();
    expect(() =>
      validateActivityQuery({
        token_id: '8',
        contract: `${contract},${contract}`
      })
    ).toThrow();
    expect(validateActivityQuery({ token_id: '8', contract }).token_id).toBe(
      '8'
    );
  });

  it('accepts only encoded cursor objects', () => {
    const value = { v: 1, offset: 50 };
    expect(decodeMarketCursor(encodeMarketCursor(value))).toEqual(value);
    for (const invalid of [null, [], 'cursor', 1]) {
      expect(() => decodeMarketCursor(encodeMarketCursor(invalid))).toThrow(
        'Invalid market cursor'
      );
    }
    expect(() => decodeMarketCursor('not+base64')).toThrow(
      'Invalid market cursor'
    );
  });
});
