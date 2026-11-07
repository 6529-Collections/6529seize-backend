import * as mysql from 'mysql';

/**
 * Inlined IN-list size per statement. The driver inlines every value, and
 * RDS Proxy pins a session for statements over 16 KB; this leaves room for
 * the rest of the statement text.
 */
export const SQL_IN_LIST_CHUNK_BYTES = 12_000;

/** Bytes the driver inlines for these values as one comma-separated list. */
export function sqlInListBytes(values: readonly (string | number)[]): number {
  return Array.from(new Set(values)).reduce<number>(
    (total, value, index) =>
      total + Buffer.byteLength(mysql.escape(value), 'utf8') + (index ? 2 : 0),
    0
  );
}

/**
 * Splits distinct values (first-occurrence order) into chunks whose escaped,
 * comma-separated literal list stays within maxBytes. A single value larger
 * than the budget forms its own chunk.
 */
export function chunkSqlInListValues<T extends string | number>(
  values: readonly T[],
  maxBytes: number = SQL_IN_LIST_CHUNK_BYTES
): T[][] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive number');
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const value of Array.from(new Set(values))) {
    const bytes = Buffer.byteLength(mysql.escape(value), 'utf8');
    // ", " separates inlined values (my-sql.helpers prepareStatement).
    if (current.length && currentBytes + 2 + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    currentBytes += current.length ? 2 + bytes : bytes;
    current.push(value);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export interface SqlInListChunkOptions {
  /** Inlined list budget per statement; divide it by the list's occurrences. */
  readonly maxBytes?: number;
  /** Run chunks one at a time, e.g. on a single caller-owned connection. */
  readonly sequential?: boolean;
}

/**
 * Runs one statement per IN-list chunk (concurrently by default) and
 * concatenates rows in chunk order. Values are deduplicated first, which is
 * exact for `IN` but drops positional or duplicate semantics. Only for
 * statements whose rows each depend on a single listed value: no ORDER BY,
 * LIMIT or aggregate spanning values. Callers that need an order map rows by
 * key. Concurrent chunks each borrow a pool connection, so keep lists bounded
 * (a 1,000-UUID list is 4 chunks) or use `sequential`.
 */
export async function querySqlInListChunks<T extends string | number, R>(
  values: readonly T[],
  query: (chunk: T[]) => Promise<R[]>,
  options: SqlInListChunkOptions = {}
): Promise<R[]> {
  const chunks = chunkSqlInListValues(values, options.maxBytes);
  if (!options.sequential) {
    const results = await Promise.all(chunks.map((chunk) => query(chunk)));
    return results.flat();
  }
  return chunks.reduce<Promise<R[]>>(
    (previous, chunk) =>
      previous.then(async (rows) => rows.concat(await query(chunk))),
    Promise.resolve([])
  );
}
