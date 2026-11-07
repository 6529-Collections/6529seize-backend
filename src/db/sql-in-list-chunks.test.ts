import * as fc from 'fast-check';
import * as mysql from 'mysql';
import {
  chunkSqlInListValues,
  querySqlInListChunks,
  SQL_IN_LIST_CHUNK_BYTES,
  sqlInListBytes
} from './sql-in-list-chunks';

function inlinedBytes(values: readonly (string | number)[]): number {
  return Buffer.byteLength(
    values.map((value) => mysql.escape(value)).join(', '),
    'utf8'
  );
}

describe('chunkSqlInListValues', () => {
  it('returns no chunks for no values', () => {
    expect(chunkSqlInListValues([])).toEqual([]);
  });

  it('keeps 250 wave UUIDs (about 10 KB) in one chunk and splits 1,000', () => {
    const ids = Array.from(
      { length: 1_000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    expect(chunkSqlInListValues(ids.slice(0, 250))).toHaveLength(1);
    const chunks = chunkSqlInListValues(ids);
    expect(chunks.length).toBe(4);
    for (const chunk of chunks) {
      expect(inlinedBytes(chunk)).toBeLessThanOrEqual(SQL_IN_LIST_CHUNK_BYTES);
    }
    expect(chunks.flat()).toEqual(ids);
  });

  it('dedupes in first-occurrence order', () => {
    expect(chunkSqlInListValues(['b', 'a', 'b', 'c', 'a'], 1_000)).toEqual([
      ['b', 'a', 'c']
    ]);
  });

  it('puts a value larger than the budget in its own chunk', () => {
    const big = 'x'.repeat(50);
    expect(chunkSqlInListValues(['a', big, 'b'], 10)).toEqual([
      ['a'],
      [big],
      ['b']
    ]);
  });

  it('rejects a non-positive budget', () => {
    expect(() => chunkSqlInListValues(['a'], 0)).toThrow(RangeError);
    expect(() => chunkSqlInListValues(['a'], Number.NaN)).toThrow(RangeError);
  });

  it('partitions distinct values in order within the byte budget', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 60 }), fc.integer()), {
          maxLength: 300
        }),
        fc.integer({ min: 1, max: 2_000 }),
        (values, maxBytes) => {
          const chunks = chunkSqlInListValues(values, maxBytes);
          expect(chunks.flat()).toEqual(Array.from(new Set(values)));
          for (const chunk of chunks) {
            expect(chunk.length).toBeGreaterThan(0);
            if (chunk.length > 1) {
              expect(inlinedBytes(chunk)).toBeLessThanOrEqual(maxBytes);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('sqlInListBytes', () => {
  it('measures the distinct values as the driver inlines them', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 40 }), fc.integer()), {
          maxLength: 50
        }),
        (values) => {
          expect(sqlInListBytes(values)).toBe(
            inlinedBytes(Array.from(new Set(values)))
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('querySqlInListChunks', () => {
  it('runs nothing for an empty list', async () => {
    const query = jest.fn();
    await expect(querySqlInListChunks([], query)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('runs chunks concurrently and concatenates rows in chunk order', async () => {
    const started: string[][] = [];
    const releases: (() => void)[] = [];
    const resultPromise = querySqlInListChunks(
      ['a', 'b', 'c', 'd'],
      (chunk) => {
        started.push(chunk);
        return new Promise<string[]>((resolve) => {
          releases.push(() => resolve(chunk.map((value) => `row-${value}`)));
        });
      },
      { maxBytes: 8 }
    );
    expect(started).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ]);
    // Settle out of order; output still follows chunk order.
    releases[1]();
    releases[0]();
    await expect(resultPromise).resolves.toEqual([
      'row-a',
      'row-b',
      'row-c',
      'row-d'
    ]);
  });

  it('runs one chunk at a time when sequential', async () => {
    let active = 0;
    let maxActive = 0;
    const rows = await querySqlInListChunks(
      ['a', 'b', 'c', 'd'],
      async (chunk) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return chunk;
      },
      { maxBytes: 3, sequential: true }
    );
    expect(rows).toEqual(['a', 'b', 'c', 'd']);
    expect(maxActive).toBe(1);
  });
});
