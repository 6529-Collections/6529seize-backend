/**
 * Canonical JSON (RFC 8785, JSON Canonicalization Scheme) for the value
 * subset the sanctions artifacts use: null, booleans, safe integers, strings,
 * arrays and plain objects. Floats, `undefined`, lone surrogates and other
 * types are rejected rather than silently coerced, so every implementation
 * either produces identical bytes or fails.
 */

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CanonicalJsonError';
  }
}

/** RFC 8785 key order: UTF-16 code units, which is JS `<` on strings. */
function compareUtf16(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalJsonError(`Lone surrogate in string at ${path}`);
  }
  return JSON.stringify(value);
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalJsonError(`Only safe integers are allowed at ${path}`);
  }
  // Normalizes -0 to 0, as ECMAScript number serialization does.
  return value === 0 ? '0' : String(value);
}

function serializeArray(value: unknown[], path: string): string {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    parts.push(serialize(value[i], `${path}[${i}]`));
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(value: object, path: string): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(`Only plain objects are allowed at ${path}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareUtf16);
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(
      `${serializeString(key, path)}:${serialize(record[key], `${path}.${key}`)}`
    );
  }
  return `{${parts.join(',')}}`;
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      return serializeString(value, path);
    case 'object':
      return Array.isArray(value)
        ? serializeArray(value, path)
        : serializeObject(value, path);
    default:
      throw new CanonicalJsonError(`Unsupported ${typeof value} at ${path}`);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
