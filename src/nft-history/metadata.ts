import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { HistoryChange, HistoryEdit } from '@/entities/INFTHistoryEvent';
import {
  isPlainObject,
  MetadataPayload,
  normalizeMetadataPayload
} from '@/metadata-payload';

export async function fetchHistoryMetadata(
  uri: string
): Promise<MetadataPayload> {
  const fetchUri = uri.startsWith('ipfs://')
    ? `https://ipfs.io/ipfs/${uri.slice(7)}`
    : uri;
  return withArweaveFallback(fetchUri, async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok)
      throw new Error(`Metadata fetch failed (${response.status}): ${url}`);
    const metadata = normalizeMetadataPayload(await response.text());
    if (!metadata) throw new Error(`Invalid metadata: ${url}`);
    return metadata;
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
    return keys.every((key) => sameValue(a[key], b[key]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    );
  }
  return a === b;
}

function attributes(value: unknown): Map<string, unknown> {
  if (value == null) return new Map();
  if (!Array.isArray(value)) throw new Error('Invalid metadata attributes');
  const result = new Map<string, unknown>();
  for (const attribute of value) {
    if (
      !isPlainObject(attribute) ||
      typeof attribute.trait_type !== 'string' ||
      result.has(attribute.trait_type)
    ) {
      throw new Error('Invalid or ambiguous metadata attribute');
    }
    result.set(attribute.trait_type, attribute.value);
  }
  return result;
}

function attributeDiff(before: unknown, after: unknown): HistoryChange[] {
  const a = attributes(before);
  const b = attributes(after);
  return Array.from(new Set([...Array.from(a.keys()), ...Array.from(b.keys())]))
    .sort((x, y) => x.localeCompare(y))
    .filter((key) => !sameValue(a.get(key), b.get(key)))
    .map((key) => ({
      key: `attributes::${key}${attributeSuffix(a.has(key), b.has(key))}`,
      from: a.get(key) ?? '',
      to: b.get(key) ?? ''
    }));
}

function attributeSuffix(before: boolean, after: boolean): string {
  if (!before) return ' (Added)';
  return after ? '' : ' (Removed)';
}

function expandObject(before: unknown, after: unknown): boolean {
  return (
    (isPlainObject(before) && (isPlainObject(after) || after == null)) ||
    (isPlainObject(after) && before == null)
  );
}

function objectOrEmpty(value: unknown): MetadataPayload {
  return isPlainObject(value) ? value : {};
}

export function diffHistoryMetadata(
  before: MetadataPayload,
  after: MetadataPayload
): HistoryEdit {
  const changes: HistoryChange[] = [];
  function visit(a: MetadataPayload, b: MetadataPayload, prefix = '') {
    for (const key of Array.from(
      new Set([...Object.keys(a), ...Object.keys(b)])
    ).sort((x, y) => x.localeCompare(y))) {
      if (sameValue(a[key], b[key])) continue;
      if (!prefix && key === 'attributes')
        changes.push(...attributeDiff(a[key], b[key]));
      else if (expandObject(a[key], b[key])) {
        visit(
          objectOrEmpty(a[key]),
          objectOrEmpty(b[key]),
          `${prefix}${key}::`
        );
      } else
        changes.push({
          key: `${prefix}${key}`,
          from: a[key] ?? '',
          to: b[key] ?? ''
        });
    }
  }
  visit(before, after);
  return { event: 'Edit', changes };
}

export async function describeHistoryEdit(
  previousUri: string,
  uri: string
): Promise<HistoryEdit | null> {
  // Arweave IDs and URL paths are case sensitive.
  if (previousUri === uri) return null;
  const [before, after] = await Promise.all([
    fetchHistoryMetadata(previousUri),
    fetchHistoryMetadata(uri)
  ]);
  return diffHistoryMetadata(before, after);
}
