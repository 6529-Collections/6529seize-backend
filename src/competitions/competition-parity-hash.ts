import * as crypto from 'node:crypto';
import { LEGACY_GET_BOOLEAN_FIELDS } from './legacy-competition-get-facade';
import { readSequentially } from './competition-read-sequence';
import { collections } from '@/collections';

// Keep Node18 type compatibility; worker Node22 supports the faster one-shot
// primitive. Both branches produce the same SHA256 bytes.
const oneShot = (
  crypto as typeof crypto & {
    hash?: (algorithm: string, value: string, encoding: 'hex') => string;
  }
).hash;
const hex = (value: string): string =>
  oneShot
    ? oneShot('sha256', value, 'hex')
    : crypto.createHash('sha256').update(value).digest('hex');

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : Number(left > right);

/** Byte-identical to canonicalCompetitionJson, optionally after the frozen
 * facade's JSON/boolean normalization. Cache only column encodings, never data.
 * Command/signature hashing is unchanged and does not use this optimization. */
export function createParityHasher(normalizeLegacy = false) {
  const plans = new Map<
    string,
    readonly { key: string; prefix: string; boolean: boolean }[]
  >();
  function columns(record: Record<string, unknown>) {
    const keys = Object.keys(record);
    const shape = JSON.stringify(keys);
    let plan = plans.get(shape);
    if (!plan) {
      plan = keys.sort(compareStrings).map((key) => ({
        key,
        prefix: JSON.stringify(key) + ':',
        boolean: normalizeLegacy && LEGACY_GET_BOOLEAN_FIELDS.has(key)
      }));
      if (plans.size >= 128) plans.clear();
      plans.set(shape, plan);
    }
    return plan;
  }
  function encodeObject(record: Record<string, unknown>): string {
    const fields: string[] = [];
    for (const column of columns(record)) {
      const raw = record[column.key];
      if (raw === undefined && !column.boolean) continue;
      const encoded =
        column.boolean && raw !== null
          ? String(Boolean(Number(raw)))
          : encode(raw);
      fields.push(column.prefix + encoded);
    }
    return `{${fields.join(',')}}`;
  }
  function encodeLegacyString(value: string): string {
    try {
      return encode(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  function encode(value: unknown): string {
    if (
      normalizeLegacy &&
      typeof value === 'string' &&
      (value.startsWith('{') || value.startsWith('['))
    )
      return encodeLegacyString(value);
    if (value === null || typeof value !== 'object') {
      const result = JSON.stringify(value);
      if (result === undefined) throw new Error('Invalid competition payload');
      return result;
    }
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    return encodeObject(value as Record<string, unknown>);
  }
  return (value: unknown): string => hex(encode(value));
}

/** Same outer hash as competitionPayloadHash(sorted row hashes), including
 * duplicates. Fixed SHA256 hex strings need no escaping. Stream bounded chunks
 * instead of allocating another multi-megabyte canonical array string. */
export function hashParityRows(
  rows: readonly Record<string, unknown>[]
): string {
  const hash = createParityHasher(true);
  return hashOrderedRows(rows.map(hash));
}

function hashOrderedRows(hashes: string[], checkWork?: () => void): string {
  checkWork?.();
  const ordered = hashes.sort(compareStrings);
  checkWork?.();
  const result = crypto.createHash('sha256').update('[');
  for (let offset = 0; offset < ordered.length; offset += 1000) {
    checkWork?.();
    if (offset) result.update(',');
    result.update('"' + ordered.slice(offset, offset + 1000).join('","') + '"');
  }
  checkWork?.();
  return result.update(']').digest('hex');
}

/** Let the transaction deadline fire during large CPU comparisons as well as
 * SQL. Budget checks prevent work from continuing after the fence is revoked. */
export async function hashParityRowsInBudget(
  rows: readonly Record<string, unknown>[],
  checkWork?: () => void
): Promise<string> {
  const hash = createParityHasher(true);
  const hashes: string[] = [];
  await readSequentially(
    collections.chunkArray([...rows], 256),
    async (page) => {
      checkWork?.();
      hashes.push(...page.map(hash));
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkWork?.();
    }
  );
  return hashOrderedRows(hashes, checkWork);
}
