import fc from 'fast-check';
import * as mysql from 'mysql';
import {
  assertNamedParametersBindable,
  formatNamedParameters,
  isBindableSqlValue,
  SqlParameterValueError
} from '@/db/sql-named-parameters';

const scalarArbitrary = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.bigInt(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.date({ noInvalidDate: true }),
  fc.uint8Array().map((bytes) => Buffer.from(bytes))
);

describe('formatNamedParameters', () => {
  it('escapes scalars and expands flat arrays into comma-separated literals', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    expect(
      formatNamedParameters(
        'select * from t where a = :a and b in (:b) and c = :c and d = :d and e = :e',
        { a: "it's", b: [1, 'x', null], c: BigInt(10), d: date, e: true }
      )
    ).toBe(
      `select * from t where a = 'it\\'s' and b in (1, 'x', NULL) and c = '10' and d = ${mysql.escape(date)} and e = true`
    );
  });

  it('leaves placeholders without a parameter as written', () => {
    expect(
      formatNamedParameters("select '10:30' as t, :missing as m", { other: 1 })
    ).toBe("select '10:30' as t, :missing as m");
    expect(formatNamedParameters('select :a', undefined)).toBe('select :a');
  });

  it('formats every supported value exactly like the driver escape', () => {
    fc.assert(
      fc.property(
        fc.oneof(scalarArbitrary, fc.array(scalarArbitrary, { minLength: 1 })),
        (value) => {
          const expected = Array.isArray(value)
            ? value.map((item) => mysql.escape(item)).join(', ')
            : mysql.escape(value);
          expect(formatNamedParameters('x = :value', { value })).toBe(
            `x = ${expected}`
          );
        }
      )
    );
  });

  it.each([
    ['a plain object', { id: 1 }],
    ['an object with toSqlString', { toSqlString: () => 'NOW()' }],
    ['a nested array', [[1, 2]]],
    ['an array holding an object', [1, { id: 2 }]],
    ['a typed array', new Uint8Array([1, 2])],
    ['a Set', new Set([1])],
    ['a function', () => 1],
    ['a symbol', Symbol('s')]
  ])('rejects %s', (_label, value) => {
    expect(() =>
      formatNamedParameters('select * from t where id = :id', { id: value })
    ).toThrow(SqlParameterValueError);
  });

  it('does not inspect parameters the statement does not reference', () => {
    expect(
      formatNamedParameters('select :a', { a: 1, unused: { nested: true } })
    ).toBe('select 1');
  });
});

describe('assertNamedParametersBindable', () => {
  it('accepts referenced scalars and ignores unreferenced values', () => {
    expect(() =>
      assertNamedParametersBindable('select :a, :b', {
        a: 'x',
        b: [1, 2],
        extra: { k: 'v' }
      })
    ).not.toThrow();
    expect(() =>
      assertNamedParametersBindable('select :a', undefined)
    ).not.toThrow();
  });

  it('names the parameter that holds an unsupported value', () => {
    let error: unknown;
    try {
      assertNamedParametersBindable('select * from t where c = :contract', {
        contract: { 'contract` = 1 or `x': 1 }
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SqlParameterValueError);
    expect(error).toMatchObject({
      parameterName: 'contract',
      statusCode: 400
    });
  });

  it('agrees with isBindableSqlValue for arbitrary values', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const check = () =>
          assertNamedParametersBindable('x = :value', { value });
        if (isBindableSqlValue(value)) {
          expect(check).not.toThrow();
        } else {
          expect(check).toThrow(SqlParameterValueError);
        }
      })
    );
  });
});

describe('isBindableSqlValue', () => {
  it('accepts only scalars and flat arrays of scalars', () => {
    expect(isBindableSqlValue('a')).toBe(true);
    expect(isBindableSqlValue([])).toBe(true);
    expect(isBindableSqlValue([new Date(0), Buffer.from('a'), BigInt(1)])).toBe(
      true
    );
    expect(isBindableSqlValue({})).toBe(false);
    expect(isBindableSqlValue([[1]])).toBe(false);
    expect(isBindableSqlValue(new Uint8Array())).toBe(false);
  });
});
