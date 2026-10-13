import fc from 'fast-check';
import { DEFAULT_PAGE_SIZE } from './api-constants';
import { getPage, getPageSize, returnPaginatedResult } from './api-helpers';
import { MAX_PAGE } from './page-request';

const arbitraryQueryValue = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.string(),
  fc.integer().map(String),
  fc.constantFrom(undefined, '', '0', '-1', 'NaN', '1e3'),
  fc.array(fc.string())
);

function reqWith(query: Record<string, unknown>) {
  return { query };
}

describe('getPageSize', () => {
  it('always returns an integer in [1, max]', () => {
    fc.assert(
      fc.property(
        arbitraryQueryValue,
        fc.integer({ min: 1, max: 5000 }),
        (value, max) => {
          const size = getPageSize(reqWith({ page_size: value }), max);
          expect(Number.isInteger(size)).toBe(true);
          expect(size).toBeGreaterThanOrEqual(1);
          expect(size).toBeLessThanOrEqual(max);
        }
      )
    );
  });

  it('uses the default maximum when none is supplied', () => {
    fc.assert(
      fc.property(arbitraryQueryValue, (value) => {
        const size = getPageSize(reqWith({ page_size: value }));
        expect(size).toBeGreaterThanOrEqual(1);
        expect(size).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE);
      })
    );
  });

  it('never returns zero or negative sizes', () => {
    for (const value of ['0', '-1', '-100', 0, -7, '-0']) {
      expect(getPageSize(reqWith({ page_size: value }))).toBe(1);
      expect(getPageSize(reqWith({ page_size: value }), 250)).toBe(1);
    }
  });

  it('resolves absent or invalid sizes to the maximum', () => {
    for (const value of [undefined, '', 'abc', '1.5', ['5', '6']]) {
      expect(getPageSize(reqWith({ page_size: value }))).toBe(
        DEFAULT_PAGE_SIZE
      );
      expect(getPageSize(reqWith({ page_size: value }), 250)).toBe(250);
    }
    expect(getPageSize(reqWith({}), 101)).toBe(101);
  });

  it('keeps valid sizes and caps oversized ones', () => {
    expect(getPageSize(reqWith({ page_size: '10' }), 250)).toBe(10);
    expect(getPageSize(reqWith({ page_size: '250' }), 250)).toBe(250);
    expect(getPageSize(reqWith({ page_size: '251' }), 250)).toBe(250);
    expect(getPageSize(reqWith({ page_size: '999999999999' }), 250)).toBe(250);
  });
});

describe('getPage', () => {
  it('always returns an integer in [1, MAX_PAGE]', () => {
    fc.assert(
      fc.property(arbitraryQueryValue, (value) => {
        const page = getPage(reqWith({ page: value }));
        expect(Number.isInteger(page)).toBe(true);
        expect(page).toBeGreaterThanOrEqual(1);
        expect(page).toBeLessThanOrEqual(MAX_PAGE);
      })
    );
  });

  it('never returns zero or negative pages', () => {
    for (const value of ['0', '-1', '-100', 0, -7]) {
      expect(getPage(reqWith({ page: value }))).toBe(1);
    }
  });

  it('defaults to the first page and keeps valid pages', () => {
    expect(getPage(reqWith({}))).toBe(1);
    expect(getPage(reqWith({ page: 'abc' }))).toBe(1);
    expect(getPage(reqWith({ page: '7' }))).toBe(7);
    expect(getPage(reqWith({ page: '99999999999999999999' }))).toBe(MAX_PAGE);
  });
});

describe('returnPaginatedResult next link', () => {
  function respond(originalUrl: string) {
    const json = jest.fn((body: unknown) => body);
    const request = {
      protocol: 'https',
      get: () => 'api.example.com',
      originalUrl
    } as any;
    const result = { count: 10, page: 1, next: 'true', data: [] as number[] };
    returnPaginatedResult(result, request, { json } as any);
    return json.mock.calls[0][0] as { next: string | null };
  }

  it('advances the page parameter', () => {
    expect(respond('/api/things?page=3&page_size=10').next).toBe(
      'https://api.example.com/api/things?page_size=10&page=4'
    );
  });

  it('points a non-positive or invalid page at the following first-page window', () => {
    expect(respond('/api/things?page=0').next).toBe(
      'https://api.example.com/api/things?page=2'
    );
    expect(respond('/api/things?page=-4').next).toBe(
      'https://api.example.com/api/things?page=2'
    );
  });

  it('does not emit a link beyond the page ceiling', () => {
    expect(respond(`/api/things?page=${MAX_PAGE}`).next).toBeNull();
    expect(respond('/api/things?page=99999999999').next).toBeNull();
  });
});
