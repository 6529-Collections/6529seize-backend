import * as fc from 'fast-check';
import {
  canonicalJson,
  canonicalJsonBytes,
  CanonicalJsonError
} from '@/sanctions/canonical-json';
import { readSanctionsVector } from '@/sanctions/sanctions-spec-files';

interface CanonicalVectors {
  cases: Array<{ input: unknown; output: string }>;
  errors: Array<{ description: string; input: unknown }>;
}

const vectors = readSanctionsVector<CanonicalVectors>('canonical-json.json');

const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    fc.string({ unit: 'grapheme' }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ unit: 'grapheme' }), tie('value'), {
      maxKeys: 4
    })
  )
})).value;

describe('canonicalJson', () => {
  it.each(vectors.cases)('serializes vector %#', ({ input, output }) => {
    expect(canonicalJson(input)).toBe(output);
    expect(canonicalJsonBytes(input).toString('utf8')).toBe(output);
  });

  it.each(vectors.errors)('rejects $description', ({ input }) => {
    expect(() => canonicalJson(input)).toThrow(CanonicalJsonError);
  });

  it.each([
    ['undefined in an object', { a: undefined }],
    ['a Date', [new Date(0)]],
    ['a Map', [new Map()]],
    ['NaN', [Number.NaN]]
  ])('rejects %s', (_label, input) => {
    expect(() => canonicalJson(input)).toThrow(CanonicalJsonError);
  });

  it('normalizes negative zero to 0', () => {
    expect(canonicalJson([-0])).toBe('[0]');
  });

  it('is a fixed point of parse and re-serialize', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      })
    );
  });

  it('does not depend on key insertion order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.maxSafeInteger(), { maxKeys: 8 }),
        (record) => {
          const reversed: Record<string, number> = {};
          for (const key of Object.keys(record).reverse()) {
            Object.defineProperty(reversed, key, {
              value: record[key],
              enumerable: true
            });
          }
          expect(canonicalJson(reversed)).toBe(canonicalJson(record));
        }
      )
    );
  });
});
