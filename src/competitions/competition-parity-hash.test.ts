import fc from 'fast-check';
import {
  createParityHasher,
  hashParityRows,
  hashParityRowsInBudget
} from './competition-parity-hash';
import { competitionPayloadHash } from './competition-command-identity';
import { LEGACY_GET_BOOLEAN_FIELDS } from './legacy-competition-get-facade';

// Preserve the pre-optimization oracle independently of the new encoder.
function oldNormalize(value: unknown): unknown {
  if (typeof value === 'string' && /^[{[]/.test(value)) {
    try {
      return oldNormalize(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(oldNormalize);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        LEGACY_GET_BOOLEAN_FIELDS.has(key) && item !== null
          ? Boolean(Number(item))
          : oldNormalize(item)
      ])
    );
  return value;
}

function oldRowHash(rows: readonly Record<string, unknown>[]): string {
  return competitionPayloadHash(
    rows
      .map(oldNormalize)
      .map(competitionPayloadHash)
      .sort((a, b) => a.localeCompare(b))
  );
}

describe('byte-compatible parity hashing', () => {
  it('matches command canonical encoding across arbitrary JSON values and shapes', () => {
    const hash = createParityHasher();
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 12 }), (values) => {
        for (const value of values)
          expect(hash(value)).toBe(competitionPayloadHash(value));
      }),
      { numRuns: 300 }
    );
  });

  it('matches the original facade multiset hashes and preserves duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.dictionary(fc.string(), fc.jsonValue()), {
          maxLength: 20
        }),
        (rows) => {
          const duplicated = [...rows, ...rows.slice(0, 2)];
          expect(hashParityRows(duplicated)).toBe(oldRowHash(duplicated));
          expect(hashParityRows([...duplicated].reverse())).toBe(
            oldRowHash(duplicated)
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  it.each(
    [null, undefined, 0, 1, -1, '', '0', '1', true, false, [1], {}].map(
      (value) => [value]
    )
  )(
    'retains nested legacy boolean and JSON-string coercion for %p',
    (value) => {
      const row = {
        voting_signature_required: value,
        participation_signature_required: value,
        forbid_negative_votes: value,
        optional: undefined,
        nested: '[{"voting_signature_required":"1","a":"[1,2]"}]',
        invalid_json: '[not json',
        text: '\ud800雪',
        date: new Date(0),
        bit: Buffer.from([0]),
        negative_zero: -0,
        not_a_number: Number.NaN,
        infinity: Number.POSITIVE_INFINITY
      };
      expect(hashParityRows([row])).toBe(oldRowHash([row]));
    }
  );

  it('keeps every column when row shapes or insertion order change', () => {
    const hash = createParityHasher(true);
    for (const row of [{ a: 1 }, { b: 2, a: 1 }, { a: 1, b: 2 }, {}])
      expect(hash(row)).toBe(competitionPayloadHash(oldNormalize(row)));
    expect(hashParityRows([{ a: 1 }, { a: 1, extra: 'tail' }])).not.toBe(
      hashParityRows([{ a: 1 }, { a: 1 }])
    );
  });

  it('keeps chunk boundaries, duplicate counts and rows beyond 10000 exact', () => {
    for (const size of [0, 1, 999, 1000, 1001, 13583]) {
      const rows = Array.from({ length: size }, (_, id) => ({ id, value: 0 }));
      expect(hashParityRows(rows)).toBe(oldRowHash(rows));
      if (size) {
        const corrupt = [...rows.slice(0, -1), { id: -1, value: 0 }];
        expect(hashParityRows(corrupt)).not.toBe(hashParityRows(rows));
      }
    }
  });

  it('bounds plan caching without omitting later distinct shapes', () => {
    const hash = createParityHasher();
    for (let index = 0; index < 300; index++) {
      const row = { ['column_' + index]: index, stable: -0 };
      expect(hash(row)).toBe(competitionPayloadHash(row));
    }
    expect(hash({ stable: 0 })).toBe(competitionPayloadHash({ stable: 0 }));
  });

  it('keeps cooperative hashing identical, and yields before accepting the result', async () => {
    const rows = Array.from({ length: 13583 }, (_, id) => ({ id, value: 0 }));
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    expect(await hashParityRowsInBudget(rows)).toBe(oldRowHash(rows));
    expect(yielded).toBe(true);
  });

  it('rejects revoked CPU work rather than returning a partial comparison', async () => {
    const revoked = new Error('revoked');
    let checks = 0;
    await expect(
      hashParityRowsInBudget(
        Array.from({ length: 1000 }, (_, id) => ({ id })),
        () => {
          if (++checks === 3) throw revoked;
        }
      )
    ).rejects.toBe(revoked);
    expect(checks).toBe(3);
  });
});
