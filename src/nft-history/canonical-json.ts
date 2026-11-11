import { createHash } from 'node:crypto';
import { isPlainObject } from '@/metadata-payload';

export function canonicalJson(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (!isPlainObject(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, normalize(item[key])])
    );
  }
  return JSON.stringify(normalize(value));
}

export function historyDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
