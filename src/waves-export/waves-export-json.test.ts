import fc from 'fast-check';
import { compareCodePoints, fetchForm, pythonJson } from './waves-export.json';

describe('pythonJson', () => {
  it("writes Python's json.dumps(ensure_ascii=False) form", () => {
    // Python: json.dumps(value, ensure_ascii=False) of the same value.
    expect(
      pythonJson({
        id: 'a',
        serial_no: 12,
        l: [1, 2, []],
        o: {},
        s: 'q"b\\s\nné',
        b: true,
        z: null
      })
    ).toBe(
      '{"id": "a", "serial_no": 12, "l": [1, 2, []], "o": {}, "s": "q\\"b\\\\s\\nné", "b": true, "z": null}'
    );
    // Python leaves DEL, U+2028 and other non-ASCII text unescaped too.
    expect(pythonJson('\u007f é')).toBe('"\u007f é"');
  });

  it('leaves out undefined fields, as the API response does', () => {
    expect(pythonJson({ a: undefined, b: 1 })).toBe('{"b": 1}');
    expect(pythonJson([undefined])).toBe('[null]');
  });

  it('starts a drop line the way the snapshot tooling reads it', () => {
    const line = pythonJson({ id: 'drop-1', serial_no: 77, title: null });
    expect(line.slice(8, line.indexOf('"', 8))).toBe('drop-1');
    const k = line.indexOf('"serial_no": ');
    expect(Number(line.slice(k + 13, line.indexOf(',', k)))).toBe(77);
  });

  it('writes a fractional number as its API text, a string', () => {
    // The fetch stage parses the API's JSON with parse_float=str.
    expect(pythonJson({ a: 1.5, b: 0.00001, c: 1e-7, d: 2 })).toBe(
      '{"a": "1.5", "b": "0.00001", "c": "1e-7", "d": 2}'
    );
  });

  it('refuses what JSON cannot hold', () => {
    expect(() => pythonJson(Number.NaN)).toThrow();
    expect(() => pythonJson(() => 1)).toThrow();
  });
});

describe('fetchForm', () => {
  it.each([
    // The API's JSON text, and what Python's json.loads(text,
    // parse_float=str) holds for it.
    [12, 12],
    [-3, -3],
    [1e16, 1e16],
    [0.5, '0.5'],
    [0.00001, '0.00001'],
    [1e-7, '1e-7'],
    [1e21, '1e+21'],
    [-0.00012, '-0.00012']
  ])('holds %p as %p', (value, held) => {
    expect(fetchForm(value)).toEqual(held);
  });

  it('keeps every number readable back from what it holds', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        const value = Object.is(x, -0) ? 0 : x;
        expect(Number(fetchForm(value))).toBe(value);
      })
    );
  });

  it('holds nested values, dates as ISO text, no undefined fields', () => {
    expect(
      fetchForm({
        a: [1, 0.25, { b: undefined, c: new Date(Date.UTC(2026, 0, 1)) }],
        d: undefined
      })
    ).toEqual({ a: [1, '0.25', { c: '2026-01-01T00:00:00.000Z' }] });
  });
});

describe('compareCodePoints', () => {
  it("orders as Python's sorted does", () => {
    // Python: sorted(['！', '\U0001F600', 'a', ':+1:'])
    expect(['！', '\u{1F600}', 'a', ':+1:'].sort(compareCodePoints)).toEqual([
      ':+1:',
      'a',
      '！',
      '\u{1F600}'
    ]);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('a', 'a')).toBe(0);
  });
});
