import fc from 'fast-check';
import {
  XTDH_GRANT_LIMIT_DEFAULTS,
  xTdhGrantLimits,
  xTdhGrantTokensProblem
} from './xtdh-grant-limits';

const limits = { maxTokens: 100, maxRangeWidth: 50 };

describe('xTdhGrantLimits', () => {
  it('defaults to 10,000 tokens, 10,000 per range and 50 pending grants', () => {
    expect(XTDH_GRANT_LIMIT_DEFAULTS).toEqual({
      maxTokens: 10_000,
      maxRangeWidth: 10_000,
      maxPendingGrants: 50
    });
    expect(xTdhGrantLimits({})).toEqual(XTDH_GRANT_LIMIT_DEFAULTS);
  });

  it('reads positive whole numbers and ignores anything else', () => {
    expect(
      xTdhGrantLimits({
        XTDH_GRANT_MAX_TOKENS: '20000',
        XTDH_GRANT_MAX_RANGE_WIDTH: '0',
        XTDH_MAX_PENDING_GRANTS: 'many'
      })
    ).toEqual({ ...XTDH_GRANT_LIMIT_DEFAULTS, maxTokens: 20_000 });
  });
});

describe('xTdhGrantTokensProblem', () => {
  it('accepts an empty list (the whole collection)', () => {
    expect(xTdhGrantTokensProblem([], limits)).toBeNull();
  });

  it('accepts ranges and tokens up to the limits', () => {
    expect(xTdhGrantTokensProblem(['1-50', '51-100'], limits)).toBeNull();
    expect(xTdhGrantTokensProblem(['1-50', '60', '70-118'], limits)).toBeNull();
  });

  it('rejects a range wider than the range limit', () => {
    expect(xTdhGrantTokensProblem(['1-51'], limits)).toBe(
      'Range "1-51" covers 51 tokens; a range can cover at most 50.'
    );
  });

  it('rejects a request whose ranges add up past the token limit', () => {
    expect(xTdhGrantTokensProblem(['1-50', '51-100', '101'], limits)).toBe(
      'A grant can target at most 100 tokens; grant the whole collection to cover more.'
    );
  });

  it('rejects more listed tokens than the token limit without reading them', () => {
    const tokens = Array.from({ length: 101 }, (_, i) => `${i}`);
    expect(xTdhGrantTokensProblem(tokens, limits)).toContain('at most 100');
  });

  it('rejects huge ranges without expanding them', () => {
    expect(
      xTdhGrantTokensProblem(['0-99999999999999'], {
        maxTokens: 10_000,
        maxRangeWidth: 10_000
      })
    ).toBe(
      'Range "0-99999999999999" covers 100000000000000 tokens; a range can cover at most 10000.'
    );
  });

  it('rejects ranges beyond safe integers but keeps large single ids', () => {
    const big =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(xTdhGrantTokensProblem([big], limits)).toBeNull();
    expect(
      xTdhGrantTokensProblem([`9007199254740992-9007199254740993`], limits)
    ).toContain('must use token ids up to 9007199254740991');
  });

  it('counts exactly what the use case would expand', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.nat(1_000), fc.option(fc.integer({ min: 1, max: 60 }))),
          { maxLength: 10 }
        ),
        (items) => {
          const tokens = items.map(([start, width]) =>
            width === null ? `${start}` : `${start}-${start + width}`
          );
          const expanded = items.reduce(
            (sum, [, width]) => sum + (width === null ? 1 : width + 1),
            0
          );
          const widest = Math.max(
            0,
            ...items.map(([, width]) => (width === null ? 1 : width + 1))
          );
          const problem = xTdhGrantTokensProblem(tokens, limits);
          expect(problem === null).toBe(
            expanded <= limits.maxTokens && widest <= limits.maxRangeWidth
          );
        }
      )
    );
  });
});
