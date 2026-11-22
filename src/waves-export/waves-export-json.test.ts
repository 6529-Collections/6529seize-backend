import fc from 'fast-check';
import {
  compareCodePoints,
  pythonJson,
  pythonNumber
} from './waves-export.json';

describe('pythonJson', () => {
  it("writes Python's json.dumps(ensure_ascii=False) form", () => {
    // Python: json.dumps(value, ensure_ascii=False) of the same value.
    expect(
      pythonJson({
        id: 'a',
        serial_no: 12,
        f: 1.5,
        l: [1, 2, []],
        o: {},
        s: 'q"b\\s\nné',
        b: true,
        z: null
      })
    ).toBe(
      '{"id": "a", "serial_no": 12, "f": 1.5, "l": [1, 2, []], "o": {}, "s": "q\\"b\\\\s\\nné", "b": true, "z": null}'
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

  it.each([
    // Python 3: json.dumps(float(text)) for the API's text.
    [0.5, '0.5'],
    [1.5, '1.5'],
    [0.1, '0.1'],
    [0.0001, '0.0001'],
    [0.00001, '1e-05'],
    [1e-7, '1e-07'],
    [123456.789, '123456.789'],
    [1234567890123.25, '1234567890123.25'],
    [-0.00012, '-0.00012'],
    [2.5e-10, '2.5e-10'],
    [5e-324, '5e-324'],
    [0.30000000000000004, '0.30000000000000004'],
    [1e15 + 0.5, '1000000000000000.5'],
    [-1.5, '-1.5'],
    // Whole numbers: Python read them as ints, or, past 1e21, as floats.
    [12, '12'],
    [-3, '-3'],
    [1e16, '10000000000000000'],
    [1e21, '1e+21'],
    [1.7976931348623157e308, '1.7976931348623157e+308']
  ])('writes %p as %s', (value, text) => {
    expect(pythonNumber(value)).toBe(text);
  });

  it('writes numbers that read back the same', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        const value = Object.is(x, -0) ? 0 : x;
        expect(Number(pythonNumber(value))).toBe(value);
      })
    );
  });

  it('refuses what JSON cannot hold', () => {
    expect(() => pythonJson(Number.NaN)).toThrow();
    expect(() => pythonJson(() => 1)).toThrow();
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
