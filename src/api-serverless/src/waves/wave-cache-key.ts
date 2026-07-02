import { createHash } from 'node:crypto';

export function stableCacheHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCacheValue(value)))
    .digest('hex');
}

export function compareCacheStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function stableCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableCacheValue);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.keys(value)
    .sort(compareCacheStrings)
    .reduce(
      (acc, key) => {
        const rawValue = (value as Record<string, unknown>)[key];
        if (rawValue !== undefined) {
          acc[key] = stableCacheValue(rawValue);
        }
        return acc;
      },
      {} as Record<string, unknown>
    );
}
