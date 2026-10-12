import fc from 'fast-check';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  normalizePage,
  normalizePageSize
} from './page-request';

const arbitraryUntrustedInput = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.bigInt(),
  fc.string(),
  fc.integer().map(String),
  fc.integer().map((n) => ` ${n} `),
  fc.double().map(String),
  fc.constantFrom(undefined, null, true, false, '', '0', '-0', '1e3', '0x10'),
  fc.array(fc.oneof(fc.string(), fc.integer())),
  fc.object()
);

describe('normalizePageSize', () => {
  it('always returns an integer in [1, max] for arbitrary input', () => {
    fc.assert(
      fc.property(
        arbitraryUntrustedInput,
        fc.integer({ min: 1, max: 100_000 }),
        (value, max) => {
          const result = normalizePageSize(value, max);
          expect(Number.isInteger(result)).toBe(true);
          expect(result).toBeGreaterThanOrEqual(1);
          expect(result).toBeLessThanOrEqual(max);
        }
      )
    );
  });

  it('keeps in-range integers unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }).chain((max) =>
          fc.record({
            max: fc.constant(max),
            size: fc.integer({ min: 1, max })
          })
        ),
        ({ max, size }) => {
          expect(normalizePageSize(size, max)).toBe(size);
          expect(normalizePageSize(String(size), max)).toBe(size);
        }
      )
    );
  });

  it('floors zero and negative sizes at 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
        fc.integer({ min: 1, max: 100_000 }),
        (size, max) => {
          expect(normalizePageSize(size, max)).toBe(1);
          expect(normalizePageSize(String(size), max)).toBe(1);
        }
      )
    );
  });

  it('caps sizes above max at max', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (max, extra) => {
          expect(normalizePageSize(max + extra, max)).toBe(max);
        }
      )
    );
  });

  it('resolves absent or non-integer values to the fallback', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc',
      '1.5',
      NaN,
      Infinity,
      ['1', '2'],
      {}
    ]) {
      expect(normalizePageSize(value, 200)).toBe(200);
      expect(normalizePageSize(value, 200, 25)).toBe(25);
    }
  });

  it('defaults the ceiling to the largest safe integer', () => {
    expect(normalizePageSize(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(normalizePageSize('100000000000000000000')).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(normalizePageSize('-100000000000000000000')).toBe(1);
    expect(normalizePageSize(0)).toBe(1);
  });

  it('falls back to the default page size when max is not a positive safe integer', () => {
    for (const max of [0, -5, NaN, Infinity, 1.5]) {
      expect(normalizePageSize('9999', max)).toBe(DEFAULT_PAGE_SIZE);
    }
  });
});

describe('normalizePage', () => {
  it('always returns an integer in [1, MAX_PAGE] for arbitrary input', () => {
    fc.assert(
      fc.property(arbitraryUntrustedInput, (value) => {
        const result = normalizePage(value);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(MAX_PAGE);
      })
    );
  });

  it('keeps in-range integers unchanged', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_PAGE }), (page) => {
        expect(normalizePage(page)).toBe(page);
        expect(normalizePage(String(page))).toBe(page);
      })
    );
  });

  it('resolves zero, negative and non-integer pages to the first page', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
        (page) => {
          expect(normalizePage(page)).toBe(1);
          expect(normalizePage(String(page))).toBe(1);
        }
      )
    );
    for (const value of [undefined, null, '', 'abc', '1.5', NaN, ['2']]) {
      expect(normalizePage(value)).toBe(1);
    }
  });

  it('caps absurd pages at MAX_PAGE', () => {
    expect(normalizePage(MAX_PAGE + 1)).toBe(MAX_PAGE);
    expect(normalizePage('99999999999999999999')).toBe(MAX_PAGE);
    expect(normalizePage(Number.MAX_SAFE_INTEGER)).toBe(MAX_PAGE);
  });
});
