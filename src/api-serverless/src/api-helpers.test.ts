import fc from 'fast-check';
import { DEFAULT_PAGE_SIZE } from './api-constants';
import {
  cacheKey,
  getPage,
  getPageSize,
  MAX_VERBATIM_CACHE_KEY_URL_LENGTH,
  normalizeRequestUrl,
  returnPaginatedResult
} from './api-helpers';
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
  function respond(originalUrl: string, host = 'api.6529.io') {
    const json = jest.fn((body: unknown) => body);
    const request = {
      protocol: 'https',
      get: () => host,
      originalUrl
    } as any;
    const result = { count: 10, page: 1, next: 'true', data: [] as number[] };
    returnPaginatedResult(result, request, { json } as any);
    return json.mock.calls[0][0] as { next: string | null };
  }

  it('advances the page parameter', () => {
    expect(respond('/api/things?page=3&page_size=10').next).toBe(
      'https://api.6529.io/api/things?page_size=10&page=4'
    );
  });

  it('points a non-positive or invalid page at the following first-page window', () => {
    expect(respond('/api/things?page=0').next).toBe(
      'https://api.6529.io/api/things?page=2'
    );
    expect(respond('/api/things?page=-4').next).toBe(
      'https://api.6529.io/api/things?page=2'
    );
  });

  it('does not emit a link beyond the page ceiling', () => {
    expect(respond(`/api/things?page=${MAX_PAGE}`).next).toBeNull();
    expect(respond('/api/things?page=99999999999').next).toBeNull();
  });
});

describe('returnPaginatedResult next link origin', () => {
  const originalOrigin = process.env.API_PUBLIC_ORIGIN;

  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.API_PUBLIC_ORIGIN;
    else process.env.API_PUBLIC_ORIGIN = originalOrigin;
  });

  function nextFor(originalUrl: string, host: string | undefined) {
    const json = jest.fn((body: unknown) => body);
    const request = {
      protocol: 'https',
      get: () => host,
      originalUrl
    } as any;
    const result = { count: 10, page: 1, next: 'true', data: [] as number[] };
    returnPaginatedResult(result, request, { json } as any);
    return (json.mock.calls[0][0] as { next: string | null }).next;
  }

  it('keeps absolute links for the known API hosts and loopback', () => {
    expect(nextFor('/api/things?page=1', 'api.staging.6529.io')).toBe(
      'https://api.staging.6529.io/api/things?page=2'
    );
    expect(nextFor('/api/things', 'localhost:3000')).toBe(
      'https://localhost:3000/api/things?&page=2'
    );
  });

  it('returns a root-relative link for any other host', () => {
    expect(nextFor('/api/things?page=1', 'somewhere.example')).toBe(
      '/api/things?page=2'
    );
    expect(nextFor('/api/things?a=1', 'somewhere.example')).toBe(
      '/api/things?a=1&page=2'
    );
    expect(nextFor('/api/things', undefined)).toBe('/api/things?&page=2');
  });

  it('never produces a protocol-relative link', () => {
    fc.assert(
      fc.property(fc.string(), (suffix) => {
        const next = nextFor(`//${suffix}`, 'somewhere.example');
        expect(next === null || !next.startsWith('//')).toBe(true);
      })
    );
  });

  it('prefers the configured public origin', () => {
    process.env.API_PUBLIC_ORIGIN = 'https://api.6529.io';
    expect(nextFor('/api/things?page=1', 'somewhere.example')).toBe(
      'https://api.6529.io/api/things?page=2'
    );
  });
});

describe('cacheKey', () => {
  const key = (originalUrl: string) => cacheKey({ originalUrl } as any);

  it('ignores query parameter order', () => {
    expect(key('/api/things?b=2&a=1')).toBe(key('/api/things?a=1&b=2'));
    expect(key('/api/things?a=1&b=2')).toBe(
      `__SEIZE_CACHE_${process.env.NODE_ENV}__/api/things?a=1&b=2`
    );
  });

  it('keeps the order of repeated values and distinct values apart', () => {
    expect(key('/api/things?a=1&a=2')).not.toBe(key('/api/things?a=2&a=1'));
    expect(key('/api/things?a=1')).not.toBe(key('/api/things?a=2'));
    expect(key('/api/things')).not.toBe(key('/api/other'));
  });

  it('treats equivalent encodings as the same URL', () => {
    expect(key('/api/things?search=a%2Cb')).toBe(key('/api/things?search=a,b'));
    expect(key('/api/things?')).toBe(key('/api/things'));
  });

  it('hashes long URLs but keeps their path as the key prefix', () => {
    const long = `/api/things?x=${'y'.repeat(2000)}`;
    const longKey = key(long);
    expect(longKey.length).toBeLessThan(200);
    expect(longKey).toMatch(/\/api\/things\?__q=[0-9a-f]{64}$/);
    expect(key(`${long}z`)).not.toBe(longKey);
  });

  it('bounds the key length for any URL', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), (suffix) => {
        expect(key(`/api/things${suffix}`).length).toBeLessThanOrEqual(
          MAX_VERBATIM_CACHE_KEY_URL_LENGTH + 200
        );
      })
    );
  });

  it('normalises without reordering a query-less URL', () => {
    expect(normalizeRequestUrl('/api/things')).toBe('/api/things');
    expect(normalizeRequestUrl('/api/things?z=1&a=2&m=3')).toBe(
      '/api/things?a=2&m=3&z=1'
    );
  });
});
