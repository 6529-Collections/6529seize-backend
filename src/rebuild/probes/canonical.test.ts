import * as fc from 'fast-check';
import {
  canonicalAnswer,
  canonicalStringify,
  parsePath
} from '@/rebuild/probes/canonical';

describe('canonical answers', () => {
  it('parses the path subset and refuses anything else', () => {
    expect(parsePath('$')).toEqual([]);
    expect(parsePath('$.data[*].created_at')).toEqual([
      { key: 'data' },
      { all: true },
      { key: 'created_at' }
    ]);
    expect(parsePath('$[2].a')).toEqual([{ index: 2 }, { key: 'a' }]);
    expect(() => parsePath('data')).toThrow();
    expect(() => parsePath('$.a..b')).toThrow();
    expect(() => parsePath('$.a[x]')).toThrow();
  });

  it('sorts keys at every depth', () => {
    expect(canonicalStringify({ b: [{ d: 1, c: 2 }], a: null })).toBe(
      '{"a":null,"b":[{"c":2,"d":1}]}'
    );
  });

  it('gives one form for objects that differ only in key order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const reordered = JSON.parse(
          JSON.stringify(value, (_key, v) =>
            v && typeof v === 'object' && !Array.isArray(v)
              ? Object.fromEntries(Object.entries(v).reverse())
              : v
          )
        );
        expect(canonicalAnswer(reordered)).toBe(canonicalAnswer(value));
      })
    );
  });

  it('leaves out ignored paths and keeps array positions', () => {
    const body = {
      data: [
        { id: 1, created_at: 'x' },
        { id: 2, created_at: 'y' }
      ],
      server_time: 5,
      list: [1, 2, 3]
    };
    expect(
      canonicalAnswer(body, [
        '$.data[*].created_at',
        '$.server_time',
        '$.list[1]'
      ])
    ).toBe('{"data":[{"id":1},{"id":2}],"list":[1,null,3]}');
    expect(canonicalAnswer(body, ['$'])).toBe('null');
  });

  it('compares unordered arrays as sets, at the root too', () => {
    expect(canonicalAnswer({ a: [3, 1, 2] }, [], ['$.a'])).toBe(
      canonicalAnswer({ a: [1, 2, 3] }, [], ['$.a'])
    );
    expect(canonicalAnswer([{ x: 2 }, { x: 1 }], [], ['$'])).toBe(
      '[{"x":1},{"x":2}]'
    );
    expect(canonicalAnswer({ a: [3, 1] })).toBe('{"a":[3,1]}');
  });
});
