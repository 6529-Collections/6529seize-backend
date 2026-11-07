import * as mysql from 'mysql';

/**
 * Inlined IN-list size per statement. The driver inlines every value, and
 * RDS Proxy pins a session for statements over 16 KB; this leaves room for
 * the rest of the statement text.
 */
export const SQL_IN_LIST_CHUNK_BYTES = 12_000;

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
 * concatenates rows in chunk order. Only for statements whose rows each depend
 * on a single listed value: no ORDER BY, LIMIT or aggregate spanning values.
 * Callers that need an order map rows by key.
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
  const rows: R[] = [];
  for (const chunk of chunks) {
    rows.push(...(await query(chunk)));
  }
  return rows;
}
