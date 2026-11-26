import { createHash } from 'node:crypto';
import { canonicalStringify } from '@/rebuild/probes/canonical';

/** The key's body part for a request without one: the empty body's hash. */
export const EMPTY_BODY_KEY = createHash('sha256')
  .update(Buffer.alloc(0))
  .digest('hex');

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === 'object' && 'jsonrpc' in value) {
    const { id: _id, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}

/** A body read as JSON, or undefined when it is empty or not JSON. */
export function parseJson(body: Buffer): unknown {
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function sortedQuery(rawPath: string): string {
  const [pathname, query] = rawPath.split('?');
  if (!query) return pathname;
  const params = query
    .split('&')
    .filter(Boolean)
    // Code-unit order, the same on every machine; it gives every recorded
    // key the order localeCompare gave it.
    .sort((a, b) => (a < b ? -1 : Number(a > b)));
  return `${pathname}?${params.join('&')}`;
}

/**
 * The key of a request: method, path with sorted query, and the body. A
 * JSON body is compared canonically, without JSON-RPC ids, since clients
 * number their requests differently on every run.
 */
export function exchangeKey(
  method: string,
  rawPath: string,
  body: Buffer
): string {
  const json = parseJson(body);
  const bodyText =
    json === undefined
      ? createHash('sha256').update(body).digest('hex')
      : canonicalStringify(withoutIds(json));
  return `${method} ${sortedQuery(rawPath)} ${bodyText}`;
}

/**
 * The request body a key names: none for the empty body's hash, the
 * canonical JSON otherwise. Null for any other key, whose body only a hash
 * stands for.
 */
export function keyBody(key: string): Buffer | null {
  const first = key.indexOf(' ');
  const second = first < 0 ? -1 : key.indexOf(' ', first + 1);
  if (second < 0) return null;
  const text = key.slice(second + 1);
  if (text === EMPTY_BODY_KEY) return Buffer.alloc(0);
  return text.startsWith('{') || text.startsWith('[')
    ? Buffer.from(text, 'utf8')
    : null;
}
